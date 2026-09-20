import mqtt from 'mqtt';
import { z } from 'zod';
import isWorkShiftStarted from './Logic/clock.js';
import { config } from './config.js';

// --- Константы ---
const PROCESSING_TTL_MS = 3000;   // защита от повторного сканирования
const OFFLINE_AFTER_MS = 15000;   // нет heartbeat дольше этого -> устройство offline
const SWEEP_INTERVAL_MS = 5000;   // как часто проверяем, кто пропал

const TOPIC = {
  CHECK: 'skud/check',
  HEARTBEAT: 'skud/heartbeat',
  LEGACY_STATUS: 'skud/control/status', // старый общий топик, больше не используется (только чистим retained)
  // Персональные топики устройства. ESP подписывается на skud/dev/<свой id>/#
  deviceResponse: (deviceId) => `skud/dev/${deviceId}/response`,
  deviceStatus: (deviceId) => `skud/dev/${deviceId}/status`,
};

// deviceId попадает в имя топика, поэтому пускаем только безопасные символы
// (без '/', '#', '+', которые ломают MQTT-топики)
const DeviceId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_:\-]+$/);

// --- MQTT Payload Schemas (Защита от битых сообщений от ESP) ---
const HeartbeatPayload = z.object({
  device_name: DeviceId,
  role: z.enum(['reader', 'lock']).optional(),
}).passthrough(); // разрешаем лишние поля (rssi, uptime...)

const CheckPayload = z.object({
  user_id: z.string().min(1),
  direction: z.enum(['in', 'out']),
  // Поле принимаем для совместимости со старой прошивкой, но НЕ доверяем ему:
  // режим добавления карт определяется только серверным state.
  isAddingCardStatus: z.string().optional(),
  nameEspReader: DeviceId,
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

// --- In-Memory State ---
// processingCards: Map<"reader:userId", timestamp> для защиты от дребезга и утечек памяти
const processingCards = new Map();

function cleanupProcessingCards() {
  const now = Date.now();
  for (const [key, ts] of processingCards.entries()) {
    if (now - ts > PROCESSING_TTL_MS) processingCards.delete(key);
  }
}

// =====================================================================
//  РЕЕСТР УСТРОЙСТВ
//  Источник правды - коллекция Device в MongoDB.
//  state.devices - кэш в памяти: Map<deviceId, DeviceCache>
// =====================================================================

function toCache(doc) {
  return {
    deviceId: doc.deviceId,
    name: doc.name || doc.deviceId,
    role: doc.role || null,               // 'reader' | 'lock'
    status: doc.status || 'pending',      // 'pending' | 'approved' | 'blocked'
    targets: doc.targets || [],           // для reader: какие lock'и открывать
    lastSeen: 0,
    online: false,
  };
}

/** Вызвать один раз при старте сервера (после подключения к Mongo) */
export async function loadDevices(Device, state) {
  const docs = await Device.find().lean();
  state.devices = new Map(docs.map((d) => [d.deviceId, toCache(d)]));
  console.log(`[DEVICES] Loaded ${state.devices.size} devices`);
}

/** Вызывать из админки после любого изменения устройства (одобрил, сменил targets, удалил) */
export async function reloadDevice(Device, state, deviceId) {
  const doc = await Device.findOne({ deviceId }).lean();
  if (!doc) {
    state.devices.delete(deviceId);
    clearDeviceStatus(global.mqttClient, deviceId); // убираем retained удалённого устройства
    return;
  }
  const prev = state.devices.get(deviceId);
  state.devices.set(deviceId, {
    ...toCache(doc),
    lastSeen: prev?.lastSeen ?? 0,
    online: prev?.online ?? false,
  });
  // Одобрили - устройство сразу получает реальный статус, заблокировали - сразу "всё выключено"
  publishDeviceStatus(global.mqttClient, state.devices.get(deviceId), state.isEmergencyBool, state.isAddingCardBool);
}

/** Список устройств для админки (вместо старых StatusCardModuleConnection и т.п.) */
export function getDevicesSnapshot(state) {
  return [...state.devices.values()].map((d) => ({
    deviceId: d.deviceId,
    name: d.name,
    role: d.role,
    status: d.status,
    targets: d.targets,
    online: d.online,
    lastSeen: d.lastSeen,
  }));
}

// =====================================================================
//  MQTT
// =====================================================================

export function connectToMQTTClient(mqttUri, models, state) {
  const { User, AccessLog, Device } = models;

  // Синглтон клиента
  if (global.mqttClient) {
    console.log('[MQTT] Client already initialized.');
    return global.mqttClient;
  }

  if (!state.devices) state.devices = new Map();

  const client = mqtt.connect(mqttUri, {
    clean: true,
    reconnectPeriod: 5000,
    connectTimeout: 10000,
    clientId: `skud-backend-${Math.random().toString(16).slice(2)}`,
    // username/password для самого бекенда, брокер должен быть закрыт
    username: config.MQTT_USER || undefined,
    password: config.MQTT_PASS || undefined,
  });
  global.mqttClient = client;

  client.on('connect', () => {
    console.log('[MQTT] Connected to broker');
    client.subscribe(TOPIC.CHECK, { qos: 1 });
    client.subscribe(TOPIC.HEARTBEAT, { qos: 1 });
    // Чистим старый общий retained-топик, иначе он навсегда останется на брокере
    client.publish(TOPIC.LEGACY_STATUS, '', { retain: true });
    // Рассылаем текущий статус каждому устройству в его персональный топик (retain=true)
    broadcastSystemStatus(client, state.isEmergencyBool, state.isAddingCardBool, state.devices);
  });

  client.on('error', (err) => console.error('[MQTT] Connection Error:', err.message));

  // Помечаем пропавшие устройства как offline
  setInterval(() => {
    const now = Date.now();
    for (const dev of state.devices.values()) {
      const online = now - dev.lastSeen <= OFFLINE_AFTER_MS;
      if (dev.online && !online) console.log(`[MQTT] ${dev.deviceId} went offline`);
      dev.online = online;
    }
  }, SWEEP_INTERVAL_MS).unref();

  client.on('message', async (topic, message) => {
    // Периодическая чистка Map
    if (processingCards.size > 1000) cleanupProcessingCards();

    let payload;
    try {
      payload = JSON.parse(message.toString());
    } catch (e) {
      return console.warn('[MQTT] Invalid JSON:', message.toString().slice(0, 50));
    }

    // --- 1. HEARTBEAT (он же авто-регистрация) ---
    if (topic === TOPIC.HEARTBEAT) {
      const parsed = HeartbeatPayload.safeParse(payload);
      if (!parsed.success) return;

      const { device_name, role } = parsed.data;
      const now = Date.now();

      let dev = state.devices.get(device_name);

      // Неизвестное устройство: заводим со статусом pending, ждём одобрения в админке
      if (!dev) {
        dev = toCache({ deviceId: device_name, role, status: 'pending' });
        state.devices.set(device_name, dev); // синхронно, до await, чтобы не было дублей
        try {
          await Device.updateOne(
            { deviceId: device_name },
            { $setOnInsert: { deviceId: device_name, name: device_name, role, status: 'pending', targets: [] } },
            { upsert: true }
          );
          console.log(`[MQTT] New device waiting for approval: ${device_name}`);
          publishDeviceStatus(client, dev, state.isEmergencyBool, state.isAddingCardBool);
        } catch (err) {
          console.error('[MQTT] Failed to save new device:', err.message);
        }
      }

      // Роль можно подтянуть из heartbeat, если в базе её ещё нет
      if (!dev.role && role) {
        dev.role = role;
        Device.updateOne({ deviceId: device_name }, { $set: { role } }).catch(() => {});
      }

      const wasOffline = !dev.online;
      dev.lastSeen = now;
      dev.online = true;

      if (wasOffline) {
        console.log(`[MQTT] ${device_name} is online (${dev.status})`);
        publishDeviceStatus(client, dev, state.isEmergencyBool, state.isAddingCardBool);
      }
      return;
    }

    // --- 2. CARD CHECK ---
    if (topic === TOPIC.CHECK) {
      const parsed = CheckPayload.safeParse(payload);
      if (!parsed.success) {
        console.warn('[MQTT] Invalid check payload:', parsed.error.flatten());
        return;
      }

      const { user_id, direction, nameEspReader } = parsed.data;

      // Сканы принимаем только от одобренных считывателей
      const reader = state.devices.get(nameEspReader);
      if (!reader || reader.status !== 'approved' || reader.role !== 'reader') {
        return console.warn(`[MQTT] Scan from unknown/unapproved reader ignored: ${nameEspReader}`);
      }

      const userIdStr = String(user_id);
      console.log(`USER - ${userIdStr} @ ${nameEspReader}`);
      const isEntering = direction === 'in';
      console.log(`Entering - ${isEntering ? 'In' : 'Out'}`);

      // Anti-bounce / Duplicate protection (ключ учитывает считыватель)
      const dedupeKey = `${nameEspReader}:${userIdStr}`;
      if (processingCards.has(dedupeKey)) {
        return console.log(`[MQTT] Duplicate ignored for ${dedupeKey}`);
      }
      processingCards.set(dedupeKey, Date.now());

      try {
        // --- BUSINESS LOGIC ---
        const decision = await processAccessLogic({
          userIdStr, isEntering, readerId: nameEspReader,
          state, User, AccessLog,
        });

        routeDecision(client, state, reader, decision, userIdStr);

      } catch (err) {
        console.error('[MQTT] Processing Error:', err);
        // Ошибка уходит только считывателю, замки не трогаем
        publishToDevice(client, reader.deviceId, buildPayload(MQTT_RESPONSE.ERROR, userIdStr, reader.deviceId));
      } finally {
        setTimeout(() => processingCards.delete(dedupeKey), PROCESSING_TTL_MS);
      }
    }
  });

  return client;
}

/**
 * Ядро логики доступа.
 */
async function processAccessLogic({ userIdStr, isEntering, readerId, state, User, AccessLog }) {
  const now = new Date();

  // Режим добавления карт определяется ТОЛЬКО сервером.
  // Если задан state.addingCardReaderId, карты регистрирует только эта считывающая ESP.
  const addingCardMode =
    Boolean(state.isAddingCardBool) &&
    (!state.addingCardReaderId || state.addingCardReaderId === readerId);

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
    console.log("DENIED_UNKNOWN");
    await AccessLog.create({ user_id: userIdStr, isEntry: isEntering, access: false, reason: 'DENIED_UNKNOWN', timestamp: now });
    return MQTT_RESPONSE.DENIED_UNKNOWN;
  }

  // 4. ЛИМИТ МЕСТ (Только на вход)
  if (isEntering && state.isLimitWorking && state.counterCurrentUsersNow >= state.usersLimit) {
    console.log("DENIED_LIMIT");
    await AccessLog.create({ user_id: userIdStr, isEntry: true, access: false, reason: 'DENIED_LIMIT', timestamp: now });
    return MQTT_RESPONSE.DENIED_LIMIT;
  }

  // 5. АНТИПАССБЭК (Последний УСПЕШНЫЙ лог)
  const lastLog = await AccessLog.findOne({ user_id: userIdStr, access: true }).sort({ timestamp: -1 }).lean();

  if (lastLog) {
    if (isEntering && lastLog.isEntry) return MQTT_RESPONSE.DENIED_INSIDE;       // Уже внутри
    if (!isEntering && !lastLog.isEntry) return MQTT_RESPONSE.DENIED_OUTSIDE;   // Уже снаружи
  } else if (!isEntering) {
    console.log("DENIED_NO_ENTRY");
    return MQTT_RESPONSE.DENIED_NO_ENTRY; // Выход без входа
  }

  // 6. ГРАФИК СМЕН
/**  if (!isWorkShiftStarted(user.startWorkDay, user.endWorkDay, now)) {
    console.log(`Denied shift`);
    await AccessLog.create({ 
      user_id: userIdStr, 
      isEntry: isEntering, 
      access: false, 
      reason: 'DENIED_SHIFT', 
      timestamp: now 
    });
    return MQTT_RESPONSE.DENIED_SHIFT;
  } */

  // 7. РАЗРЕШЕНО
  state.counterCurrentUsersNow += isEntering ? 1 : -1;
  if (state.counterCurrentUsersNow < 0) state.counterCurrentUsersNow = 0;

  console.log(`ALLOWED`);

  // Запись лога УСПЕХА
  await AccessLog.create({
    user_id: userIdStr,
    isEntry: isEntering,
    access: true,
    reason: 'ALLOWED',
    timestamp: now,
  });

  console.log(new Date().getTime());

  // Расчет рабочего времени (При выходе)
  if (!isEntering && lastLog) {
    const entryTime = new Date(lastLog.timestamp).getTime();
    const durationMs = now.getTime() - entryTime;
    if (durationMs > 0 && durationMs < 24 * 60 * 60 * 1000) { // Защита от багов времени (>24h)
      await User.updateOne(
        { user_id: userIdStr },
        { $inc: { totalWorkMs: durationMs } }
      );

      const totalWorkMsDoc = await User.findOne({ user_id: userIdStr }, { totalWorkMs: 1 }).lean();
      console.log(`Updated totalWorkMs for ${userIdStr}: ${totalWorkMsDoc.totalWorkMs} ms`);
    }
  }

  return MQTT_RESPONSE.ALLOWED;
}

// =====================================================================
//  МАРШРУТИЗАЦИЯ ОТВЕТОВ
// =====================================================================

/** Формат сообщения остался прежним, поэтому логику разбора в прошивке менять не нужно */
function buildPayload(decision, userId, readerId) {
  return {
    status: decision.status,
    reason: decision.reason,
    user_id: userId,
    time: Date.now(),
    nameEspReader: readerId || 'unknown',
  };
}

/** Публикация в персональный топик устройства */
function publishToDevice(client, deviceId, payload) {
  if (!client?.connected) return console.error('[MQTT] Client not connected');

  console.log(`[MQTT] -> ${deviceId}: ${payload.status}/${payload.reason}`);
  client.publish(TOPIC.deviceResponse(deviceId), JSON.stringify(payload), { qos: 1 }); // QoS 1 для надежности доставки команды "Открыть"
}

/**
 * Считыватель и все одобренные замки из reader.targets получают любое решение
 * (индикация светом и звуком). Открывать замок прошивка должна ТОЛЬКО при status === '1'.
 */
function routeDecision(client, state, reader, decision, userId) {
  const payload = buildPayload(decision, userId, reader.deviceId);

  publishToDevice(client, reader.deviceId, payload);

  const locks = reader.targets
    .map((id) => state.devices.get(id))
    .filter((dev) => dev && dev.status === 'approved' && dev.role === 'lock');

  if (locks.length === 0) {
    return console.warn(`[MQTT] Reader ${reader.deviceId} has no approved lock targets`);
  }

  for (const lock of locks) {
    if (!lock.online) console.warn(`[MQTT] Target ${lock.deviceId} is offline, command may be delayed`);
    publishToDevice(client, lock.deviceId, payload);
  }
}

/**
 * Статус одному устройству (retain=true, чтобы получить его сразу после подписки).
 * Неодобренные и заблокированные устройства всегда видят "всё выключено":
 * ЧС и режим добавления карт их не касаются.
 */
function publishDeviceStatus(client, dev, isEmergency, isAddingCard) {
  if (!client?.connected || !dev) return;
  const approved = dev.status === 'approved';
  client.publish(TOPIC.deviceStatus(dev.deviceId), JSON.stringify({
    isEmergency: approved && Boolean(isEmergency),
    isAddingCard: approved && Boolean(isAddingCard),
  }), { qos: 1, retain: true });
}

function clearDeviceStatus(client, deviceId) {
  if (!client?.connected) return;
  client.publish(TOPIC.deviceStatus(deviceId), '', { retain: true });
}

/** Рассылка статуса системы (ЧС, режим карт) всем известным устройствам */
export function broadcastSystemStatus(client, isEmergency, isAddingCard, devices) {
  if (!client?.connected || !devices) return;

  for (const dev of devices.values()) {
    publishDeviceStatus(client, dev, isEmergency, isAddingCard);
  }
  console.log(`[MQTT] Broadcast Status: Emergency=${isEmergency}, AddingCard=${isAddingCard}`);
}