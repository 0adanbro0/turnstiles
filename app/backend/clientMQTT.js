const mqtt = require('mqtt');
const isWorkShiftStarted = require('./Logic/clock');

const mqttModule = {
  client: null,
  isInitialized: false 
};

const processingCards = new Set();

function connectToMQTTClient(mqttUri, models, state) {
  const { User, AccessLog } = models;
  
  if (mqttModule.client) {
    console.log('[MQTT] Клиент уже существует, пропускаем создание нового подключения.');
    return;
  }

  mqttModule.client = mqtt.connect(mqttUri);

  mqttModule.client.on('connect', () => {
    console.log('[MQTT] Бэкенд успешно подключился к Mosquitto');
    mqttModule.client.subscribe('skud/check');       
    mqttModule.client.subscribe('skud/heartbeat');   
  });

  if (mqttModule.isInitialized) return;
  mqttModule.isInitialized = true;

  mqttModule.client.on('message', async (topic, message) => {
    try {
      const payload = JSON.parse(message.toString());

      // 1. Хартбит
      if (topic === 'skud/heartbeat' && payload.device_name === "ESP32_Gate_CARD_Main") {
        const isReconnect = !state.StatusCardModuleConnection || (Date.now() - state.currentTimeCard > 15000);
        
        state.StatusCardModuleConnection = true; 
        state.currentTimeCard = Date.now();

        if (isReconnect) {
          console.log('[MQTT] ESP32 вернулась в сеть, синхронизируем режимы ЧС и карт...');
          broadcastSystemStatus(state.isEmergencyBool, state.isAddingCardBool);
        }
        return;
      }

      if (topic === 'skud/heartbeat' && payload.device_name === "ESP32_Gate_Main_Lock") {
        const isReconnect = !state.StatusMainLockModuleConnection || (Date.now() - state.currentTimeLock > 15000);
        
        state.StatusMainLockModuleConnection = true; 
        state.currentTimeLock = Date.now();

        if (isReconnect) {
          console.log('[MQTT] ESP32 super mini main lock вернулась в сеть, синхронизируем режимы ЧС и карт...');
          broadcastSystemStatus(state.isEmergencyBool, state.isAddingCardBool);
        }
        return;
      }

      //card processing
      if (topic === 'skud/check') {
        const { user_id, direction, isAddingCardStatus, nameEspReader} = payload;
        
        if (!user_id) return sendMqttResponse("0", "empty_id", "unknown", nameEspReader);

        const userIdStr = String(user_id);
        const isEntering = direction === 'in';

        if (processingCards.has(userIdStr)) {
          return console.log(`[MQTT] Карта ${userIdStr} уже в обработке. Игнорируем дубликат.`);
        }
        processingCards.add(userIdStr);

        try {
          //add card function
          if (isAddingCardStatus == "1" || state.isAddingCardBool) {
            const userExists = await User.findOne({ user_id: userIdStr });
            if (!userExists) {
              const newUser = new User({ user_id: userIdStr, name: `New Card ${userIdStr.slice(-4)}` });
              await newUser.save();
              return sendMqttResponse("registered", "saved", userIdStr, nameEspReader);
            }
            return sendMqttResponse("exists", "registered", userIdStr, nameEspReader);
          }

          //emergency function
          if (state.isEmergencyBool) {
            await new AccessLog({ user_id: userIdStr, isEntry: isEntering, access: true, reason: "EMERGENCY" }).save();
            return sendMqttResponse("1", "emergency_open", userIdStr, nameEspReader);
          }

          const userExists = await User.findOne({ user_id: userIdStr });
          if (!userExists) {
            await new AccessLog({ user_id: userIdStr, isEntry: isEntering, access: false }).save();
            return sendMqttResponse("404", "unknown", userIdStr, nameEspReader);
          }

          if (isEntering && state.isLimitWorking && state.counterCurrentUsersNow >= state.usersLimit) {
            await new AccessLog({ user_id: userIdStr, isEntry: true, access: false }).save();
            return sendMqttResponse("422", "limit", userIdStr, nameEspReader);
          }

          const lastSuccessfulLog = await AccessLog.findOne({ user_id: userIdStr, access: true }).sort({ timestamp: -1 });
          if (lastSuccessfulLog) {
            if (isEntering && lastSuccessfulLog.isEntry === true) {
              await new AccessLog({ user_id: userIdStr, isEntry: true, access: false }).save();
              return sendMqttResponse("0", "inside", userIdStr, nameEspReader);
            }
            if (!isEntering && lastSuccessfulLog.isEntry === false) {
              await new AccessLog({ user_id: userIdStr, isEntry: false, access: false }).save();
              return sendMqttResponse("0", "outside", userIdStr, nameEspReader);
            }
          } else if (!isEntering) {
            await new AccessLog({ user_id: userIdStr, isEntry: false, access: false }).save();
            return sendMqttResponse("0", "no_entry", userIdStr, nameEspReader);
          }

          const user = await User.findOne({ user_id: userIdStr})
          if(!isWorkShiftStarted(user.startWorkDay, user.endWorkDay)){
            if(isEntering){
              await new AccessLog({ user_id: userIdStr, isEntry: true, access: false }).save();
            }
            else if(!isEntering){
              await new AccessLog({ user_id: userIdStr, isEntry: false, access: false }).save();
            }

            return sendMqttResponse("0", "Work_shift_error", userIdStr, nameEspReader);
          }

          state.counterCurrentUsersNow = isEntering ? state.counterCurrentUsersNow + 1 : Math.max(0, state.counterCurrentUsersNow - 1);

          const now = new Date();
          const currentLog = new AccessLog({ user_id: userIdStr, isEntry: isEntering, access: true, timestamp: now });
          await currentLog.save();

          // work hours function
          if (!isEntering && lastSuccessfulLog) {
            const entryTime = new Date(lastSuccessfulLog.timestamp);
            const durationMs = now - entryTime;
            if (durationMs > 0) {
              await User.updateOne({ user_id: userIdStr }, { $inc: { totalWorkMs: durationMs } });
              console.log(`[TIME] Added time for ${userExists.name}: ${Math.round(durationMs / 1000)} sec.`);
            }
          }

          return sendMqttResponse("1", "allowed", userIdStr, nameEspReader);
        } finally {
          //after two seconds access process card
          setTimeout(() => processingCards.delete(userIdStr), 2000);
        }
      }
    } catch (err) {
      console.error("[MQTT ERROR]:", err);
      if (mqttModule.client) {
        mqttModule.client.publish('skud/control/response', JSON.stringify({ status: "0", reason: "error", time: Date.now() }));
      }
    }
  });
}

function sendMqttResponse(status, reason, userId, nameEspReader) {
  if (mqttModule.client && typeof mqttModule.client.publish === 'function') {
    mqttModule.client.publish('skud/control/response', JSON.stringify({ status, reason, user_id: userId, time: Date.now(), nameEspReader: nameEspReader || "unknown"}));
  } else {
    console.error("[MQTT ERROR] Ошибка публикации ответа: mqttClient не готов.");
  }
}

function broadcastSystemStatus(isEmergency, isAddingCard) {
  if (mqttModule.client && typeof mqttModule.client.publish === 'function') {
    const payload = { 
      isEmergency: Boolean(isEmergency), 
      isAddingCard: Boolean(isAddingCard) 
    };
    mqttModule.client.publish('skud/control/status', JSON.stringify(payload));
    console.log(`[MQTT] Статус успешно отправлен на ESP32. ЧС: ${payload.isEmergency}, Режим карт: ${payload.isAddingCard}`);
  } else {
    console.error("[MQTT ERROR] Ошибка широковещания: mqttClient не готов.");
  }
}

module.exports = { connectToMQTTClient, broadcastSystemStatus };
