import mqtt from 'mqtt';
import { z } from 'zod';
import isWorkShiftStarted from './Logic/clock.js';

// --- MQTT Payload Schemas (Защита от битых сообщений от ESP) ---
const HeartbeatPayload = z.object({
  device_name: z.enum(['ESP32_Gate_CARD_Main', 'ESP32_Gate_Main_Lock']),
}).passthrough(); // разрешаем лишние поля (rssi, uptime...)

const CheckPayload = z.object({
  user_id: z.string().min(1),
  direction: z.enum(['in', 'out']),
  isAddingCardStatus: z.union([z.literal('1'), z.literal('0'), z.string()]).optional(),
  nameEspReader: z.string().optional(),
}).strict();

// --- Константы ответов (нет Magic Strings) ---
export const MQTT_RESPONSE = {
  ALLOWED: { status: '1', reason: 'allowed' },
  DENIED_UNKNOWN: { status: '0', reason: 'unknown' },
  DENIED_LIMIT: { status: '422', reason: 'limit' },
  DENIED_INSIDE: { status: '0', reason: 'inside' },
  DENIED_OUTSIDE: { status: '0', reason: 'outside' },
  DENIED_NO_ENTRY: { status: '0', reason: 'no_entry' },
  DENIED_SHIFT: { status: '0', reason: 'Work_shift_error' },
  EMERGENCY: { status: '1', reason: 'emergency_open' },
  REGISTERED: { status: 'registered', reason: 'saved' },
  ALREADY_REGISTERED: { status: 'exists', reason: 'registered' },
  EMPTY_ID: { status: '0', reason: 'empty_id' },
  ERROR: { status: '0', reason: 'error' },
};

// --- In-Memory State (передается по ссылке из server.js) ---
// processingCards: Map<userId, timestamp> для защиты от дребезга и утечек памяти
const processingCards = new Map();
const PROCESSING_TTL_MS = 3000; // 3 сек защита от повторного сканирования

// Внутренняя функция очистки старых записей в Map
function cleanupProcessingCards() {
  const now = Date.now();
  for (const [key, ts] of processingCards.entries()) {
    if (now - ts > PROCESSING_TTL_MS) processingCards.delete(key);
  }
}

export function connectToMQTTClient(mqttUri, models, state) {
  const { User, AccessLog } = models;
  
  // Синглтон клиента
  if (global.mqttClient) {
    console.log('[MQTT] Client already initialized.');
    return global.mqttClient;
  }

  const client = mqtt.connect(mqttUri, {
    clean: true,
    reconnectPeriod: 5000,
    connectTimeout: 10000,
    clientId: `skud-backend-${Math.random().toString(16).slice(2)}`,
  });
  global.mqttClient = client;

  client.on('connect', () => {
    console.log('[MQTT] Connected to broker');
    client.subscribe('skud/check', { qos: 1 });
    client.subscribe('skud/heartbeat', { qos: 1 });
    // При коннекте сразу рассылаем текущий статус (retain=true чтобы новые ESP получили)
    broadcastSystemStatus(client, state.isEmergencyBool, state.isAddingCardBool);
  });

  client.on('error', (err) => console.error('[MQTT] Connection Error:', err.message));

  client.on('message', async (topic, message) => {
    // Периодическая чистка Map
    if (processingCards.size > 1000) cleanupProcessingCards();

    let payload;
    try {
      payload = JSON.parse(message.toString());
    } catch (e) {
      return console.warn('[MQTT] Invalid JSON:', message.toString().slice(0, 50));
    }

    // --- 1. HEARTBEAT ---
    if (topic === 'skud/heartbeat') {
      const parsed = HeartbeatPayload.safeParse(payload);
      if (!parsed.success) return;
      
      const { device_name } = parsed.data;
      const now = Date.now();
      let isReconnect = false;

      if (device_name === 'ESP32_Gate_CARD_Main') {
        isReconnect = !state.StatusCardModuleConnection || (now - state.currentTimeCard > 15000);
        state.StatusCardModuleConnection = true;
        state.currentTimeCard = now;
      } else if (device_name === 'ESP32_Gate_Main_Lock') {
        isReconnect = !state.StatusMainLockModuleConnection || (now - state.currentTimeLock > 15000);
        state.StatusMainLockModuleConnection = true;
        state.currentTimeLock = now;
      }

      if (isReconnect) {
        console.log(`[MQTT] ${device_name} reconnected. Syncing status...`);
        broadcastSystemStatus(client, state.isEmergencyBool, state.isAddingCardBool);
      }
      return;
    }

    // --- 2. CARD CHECK ---
    if (topic === 'skud/check') {
      const parsed = CheckPayload.safeParse(payload);
      if (!parsed.success) {
        console.warn('[MQTT] Invalid check payload:', parsed.error.flatten());
        return;
      }
      
      const { user_id, direction, isAddingCardStatus, nameEspReader } = parsed.data;
      const userIdStr = String(user_id);
      const isEntering = direction === 'in';

      // Anti-bounce / Duplicate protection
      if (processingCards.has(userIdStr)) {
        return console.log(`[MQTT] Duplicate ignored for ${userIdStr}`);
      }
      processingCards.set(userIdStr, Date.now());

      try {
        // --- BUSINESS LOGIC ---
        const decision = await processAccessLogic({
          userIdStr, isEntering, isAddingCardStatus, nameEspReader,
          state, User, AccessLog
        });

        sendMqttResponse(client, decision.status, decision.reason, userIdStr, nameEspReader);

      } catch (err) {
        console.error('[MQTT] Processing Error:', err);
        sendMqttResponse(client, MQTT_RESPONSE.ERROR.status, MQTT_RESPONSE.ERROR.reason, userIdStr, nameEspReader);
      } finally {
        // Удаляем через TTL (на всякий случай, если finally не сработает сразу)
        setTimeout(() => processingCards.delete(userIdStr), PROCESSING_TTL_MS);
      }
    }
  });

  return client;
}

/**
 * Ядро логики доступа. Чистая функция (почти), легко тестируется.
 */
async function processAccessLogic({ userIdStr, isEntering, isAddingCardStatus, nameEspReader, state, User, AccessLog }) {
  const now = new Date();
  const addingCardMode = isAddingCardStatus === '1' || state.isAddingCardBool;

  // 1. РЕЖИМ ДОБАВЛЕНИЯ КАРТ
  if (addingCardMode) {
    const exists = await User.findOne({ user_id: userIdStr }).lean();
    if (!exists) {
      await User.create({ user_id: userIdStr, name: `Card ${userIdStr.slice(-4)}` });
      return MQTT_RESPONSE.REGISTERED;
    }
    return MQTT_RESPONSE.ALREADY_REGISTERED;
  }

  // 2. ЧРЕЗВЫЧАЙНАЯ СИТУАЦИЯ
  if (state.isEmergencyBool) {
    await AccessLog.create({ user_id: userIdStr, isEntry: isEntering, access: true, reason: 'EMERGENCY', timestamp: now });
    // В ЧС счетчик не меняем или меняем? Обычно в ЧС двери открыты для всех, счетчик не важен.
    // Если нужно менять: state.counterCurrentUsersNow += isEntering ? 1 : -1;
    return MQTT_RESPONSE.EMERGENCY;
  }

  // 3. ПОЛЬЗОВАТЕЛЬ
  const user = await User.findOne({ user_id: userIdStr }).lean();
  if (!user) {
    await AccessLog.create({ user_id: userIdStr, isEntry: isEntering, access: false, reason: 'DENIED_UNKNOWN', timestamp: now });
    return MQTT_RESPONSE.DENIED_UNKNOWN;
  }

  // 4. ЛИМИТ МЕСТ (Только на вход)
  if (isEntering && state.isLimitWorking && state.counterCurrentUsersNow >= state.usersLimit) {
    await AccessLog.create({ user_id: userIdStr, isEntry: true, access: false, reason: 'DENIED_LIMIT', timestamp: now });
    return MQTT_RESPONSE.DENIED_LIMIT;
  }

  // 5. АНТИПАССБЭК (Последний УСПЕШНЫЙ лог)
  const lastLog = await AccessLog.findOne({ user_id: userIdStr, access: true }).sort({ timestamp: -1 }).lean();
  
  if (lastLog) {
    if (isEntering && lastLog.isEntry) return MQTT_RESPONSE.DENIED_INSIDE;       // Уже внутри
    if (!isEntering && !lastLog.isEntry) return MQTT_RESPONSE.DENIED_OUTSIDE;   // Уже снаружи
  } else if (!isEntering) {
    return MQTT_RESPONSE.DENIED_NO_ENTRY; // Выход без входа
  }

  // 6. ГРАФИК СМЕН
  if (!isWorkShiftStarted(user.startWorkDay, user.endWorkDay, now)) {
    await AccessLog.create({ 
      user_id: userIdStr, 
      isEntry: isEntering, 
      access: false, 
      reason: 'DENIED_SHIFT', 
      timestamp: now 
    });
    return MQTT_RESPONSE.DENIED_SHIFT;
  }

  // 7. РАЗРЕШЕНО
  // Атомарное обновление счетчика в памяти (JS single-threaded, безопасно для одного процесса)
  state.counterCurrentUsersNow += isEntering ? 1 : -1;
  if (state.counterCurrentUsersNow < 0) state.counterCurrentUsersNow = 0;

  // Запись лога УСПЕХА
  await AccessLog.create({ 
    user_id: userIdStr, 
    isEntry: isEntering, 
    access: true, 
    reason: 'ALLOWED', 
    timestamp: now 
  });

  // Расчет рабочего времени (При выходе)
  if (!isEntering && lastLog) {
    const entryTime = new Date(lastLog.timestamp).getTime();
    const durationMs = now.getTime() - entryTime;
    if (durationMs > 0 && durationMs < 24 * 60 * 60 * 1000) { // Защита от багов времени (>24h)
      await User.updateOne({ user_id: userIdStr }, { $inc: { totalWorkMs: durationMs } });
    }
  }

  return MQTT_RESPONSE.ALLOWED;
}

/** Публикация ответа на ESP */
function sendMqttResponse(client, status, reason, userId, nameEspReader) {
  if (!client?.connected) return console.error('[MQTT] Client not connected');
  
  client.publish('skud/control/response', JSON.stringify({
    status, reason, user_id: userId, 
    time: Date.now(), 
    nameEspReader: nameEspReader || 'unknown'
  }), { qos: 1 }); // QoS 1 для надежности доставки команды "Открыть"
}

/** Рассылка статуса системы (ЧС, Режим карт) — Retain=true для новых подключений */
export function broadcastSystemStatus(client, isEmergency, isAddingCard) {
  if (!client?.connected) return;
  
  const payload = JSON.stringify({ 
    isEmergency: Boolean(isEmergency), 
    isAddingCard: Boolean(isAddingCard) 
  });
  
  client.publish('skud/control/status', payload, { qos: 1, retain: true });
  console.log(`[MQTT] Broadcast Status: Emergency=${isEmergency}, AddingCard=${isAddingCard}`);
}