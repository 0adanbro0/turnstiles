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
  // Текущее время сервера для синхронизации мигания между платами. Не retained:
  // устаревшая метка времени хуже, чем её отсутствие.
  deviceTime: (deviceId) => `skud/dev/${deviceId}/time`,
  // Команда "начни регистрацию отпечатка" - от сервера к устройству
  deviceEnrollCmd: (deviceId) => `skud/dev/${deviceId}/enroll`,
  // Результат регистрации - от устройства к серверу. Подписка на этот топик идёт через
  // wildcard (skud/dev/+/enroll-result), поэтому сравнение по точной строке не подходит -
  // deviceId извлекается из пришедшего топика через ENROLL_RESULT_RE ниже.
  deviceEnrollResult: (deviceId) => `skud/dev/${deviceId}/enroll-result`,
  ENROLL_RESULT_WILDCARD: 'skud/dev/+/enroll-result',
  ENROLL_PROGRESS_WILDCARD: 'skud/dev/+/enroll-progress',
};

const ENROLL_RESULT_RE = /^skud\/dev\/([^/]+)\/enroll-result$/;
const PENDING_ENROLL_TTL_MS = 3 * 60 * 1000; // если устройство не ответило за это время - забываем заявку
const ENROLL_STATUS_TTL_MS = 2 * 60 * 1000;  // сколько держим последний статус для панели, прежде чем забыть

const ENROLL_PROGRESS_RE = /^skud\/dev\/([^/]+)\/enroll-progress$/;
const EnrollProgressPayload = z.object({ message: z.string().min(1).max(200) });

// deviceId попадает в имя топика, поэтому пускаем только безопасные символы
// (без '/', '#', '+', которые ломают MQTT-топики)
const DeviceId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_:\-]+$/);

// --- MQTT Payload Schemas (Защита от битых сообщений от ESP) ---
const EnrollResultPayload = z.object({
  ok: z.boolean(),
  error: z.string().max(200).optional(),
}).passthrough();

const HeartbeatPayload = z.object({
  device_name: DeviceId,
  role: z.enum(['reader', 'lock']).optional(),
}).passthrough(); // разрешаем лишние поля (rssi, uptime...)

const CheckPayload = z.object({
  user_id: z.string().min(1), // значение идентификатора: UID карты ИЛИ ID отпечатка в памяти сенсора
  direction: z.enum(['in', 'out']),
  // Тип способа подтверждения личности. По умолчанию "card" - старые прошивки считывателей карт
  // это поле не шлют вовсе и продолжают работать без единой правки.
  credential_type: z.enum(['card', 'fingerprint']).default('card'),
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
  publishDeviceStatus(global.mqttClient, state, state.devices.get(deviceId), state.isEmergencyBool);
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
  const { User, AccessLog, Device, Credential } = models;

  // Синглтон клиента
  if (global.mqttClient) {
    console.log('[MQTT] Client already initialized.');
    return global.mqttClient;
  }

  if (!state.devices) state.devices = new Map();
  // Заявки на регистрацию отпечатка, ждущие ответа от устройства: deviceId -> { userId, fingerprintId, requestedAt }
  if (!state.pendingEnrollments) state.pendingEnrollments = new Map();
  // Последний известный статус регистрации на человека - чтобы панель могла показать
  // "готово"/"ошибка" вместо того, чтобы смотреть в Serial Monitor платы.
  if (!state.enrollStatus) state.enrollStatus = new Map();

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
    client.subscribe(TOPIC.ENROLL_RESULT_WILDCARD, { qos: 1 });
    client.subscribe(TOPIC.ENROLL_PROGRESS_WILDCARD, { qos: 1 });
    // Чистим старый общий retained-топик, иначе он навсегда останется на брокере
    client.publish(TOPIC.LEGACY_STATUS, '', { retain: true });
    // Рассылаем текущий статус каждому устройству в его персональный топик (retain=true)
    broadcastSystemStatus(client, state);
  });

  client.on('error', (err) => console.error('[MQTT] Connection Error:', err.message));

  // Помечаем пропавшие устройства как offline + чистим зависшие заявки на регистрацию
  setInterval(() => {
    const now = Date.now();
    for (const dev of state.devices.values()) {
      const online = now - dev.lastSeen <= OFFLINE_AFTER_MS;
      if (dev.online && !online) console.log(`[MQTT] ${dev.deviceId} went offline`);
      dev.online = online;
    }
    for (const [deviceId, pending] of state.pendingEnrollments.entries()) {
      if (now - pending.requestedAt > PENDING_ENROLL_TTL_MS) {
        console.log(`[MQTT] Enrollment request for ${deviceId} timed out, dropping`);
        state.pendingEnrollments.delete(deviceId);
        setEnrollStatus(state, pending.userId, 'error', 'Устройство не ответило вовремя. Попробуйте ещё раз');
      }
    }
    for (const [userId, s] of state.enrollStatus.entries()) {
      if (now - s.updatedAt > ENROLL_STATUS_TTL_MS) state.enrollStatus.delete(userId);
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

 
    const progressMatch = topic.match(ENROLL_PROGRESS_RE);
    if (progressMatch) {
      const pending = state.pendingEnrollments.get(progressMatch[1]);
      if (!pending) return; // pending НЕ удаляем: заявка закрывается только результатом
      const parsed = EnrollProgressPayload.safeParse(payload);
      if (!parsed.success) return;
      setEnrollStatus(state, pending.userId, 'waiting', parsed.data.message, true);
      return;
    }


    // --- 0. РЕЗУЛЬТАТ РЕГИСТРАЦИИ ОТПЕЧАТКА (топик с wildcard, сравниваем через regex) ---
    const enrollMatch = topic.match(ENROLL_RESULT_RE);
    if (enrollMatch) {
      const deviceId = enrollMatch[1];
      const pending = state.pendingEnrollments.get(deviceId);
      state.pendingEnrollments.delete(deviceId); // в любом случае заявка закрыта - успех, провал, не важно

      if (!pending) {
        console.warn(`[MQTT] Enrollment result from ${deviceId} without a pending request, ignored`);
        return;
      }

      const parsed = EnrollResultPayload.safeParse(payload);
      if (!parsed.success) {
        console.warn('[MQTT] Invalid enroll result payload:', parsed.error.flatten());
        setEnrollStatus(state, pending.userId, 'error', 'Устройство прислало некорректный ответ');
        return;
      }

      if (!parsed.data.ok) {
        const message = parsed.data.error || 'Палец не распознан или два скана не совпали';
        console.log(`[MQTT] Enrollment failed on ${deviceId}: ${message}`);
        setEnrollStatus(state, pending.userId, 'error', message);
        return;
      }

      try {
        await Credential.create({ user: pending.userId, type: 'fingerprint', value: String(pending.fingerprintId) });
        console.log(`[MQTT] Fingerprint ${pending.fingerprintId} linked to user ${pending.userId}`);
        setEnrollStatus(state, pending.userId, 'ok', `Отпечаток №${pending.fingerprintId} сохранён`);
      } catch (err) {
        if (err.code === 11000) {
          console.warn(`[MQTT] Fingerprint ${pending.fingerprintId} was already taken by the time ${deviceId} finished enrolling`);
          setEnrollStatus(state, pending.userId, 'error', 'Этот номер уже оказался занят другим человеком, попробуйте ещё раз');
        } else {
          console.error('[MQTT] Failed to save credential after enrollment:', err.message);
          setEnrollStatus(state, pending.userId, 'error', 'Палец записан на сенсор, но не удалось сохранить на сервере');
        }
      }
      return;
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
          publishDeviceStatus(client, state, dev, state.isEmergencyBool);
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
        publishDeviceStatus(client, state, dev, state.isEmergencyBool);
      }
      // Каждый heartbeat (~раз в 5 с) обновляем плате текущее время сервера,
      // чтобы синхронное мигание не расходилось из-за дрейфа millis()
      client.publish(TOPIC.deviceTime(device_name), JSON.stringify({ server_time: now }));
      return;
    }

    // --- 2. CARD CHECK ---
    if (topic === TOPIC.CHECK) {
      const parsed = CheckPayload.safeParse(payload);
      if (!parsed.success) {
        console.warn('[MQTT] Invalid check payload:', parsed.error.flatten());
        return;
      }

      const { user_id, direction, credential_type, nameEspReader } = parsed.data;

      // Сканы принимаем только от одобренных считывателей
      const reader = state.devices.get(nameEspReader);
      if (!reader || reader.status !== 'approved' || reader.role !== 'reader') {
        return console.warn(`[MQTT] Scan from unknown/unapproved reader ignored: ${nameEspReader}`);
      }

      const scannedValue = String(user_id); // то, что реально пришло с датчика: UID карты или ID отпечатка
      console.log(`SCAN - ${credential_type}:${scannedValue} @ ${nameEspReader}`);
      const isEntering = direction === 'in';
      console.log(`Entering - ${isEntering ? 'In' : 'Out'}`);

      // Anti-bounce / Duplicate protection (ключ учитывает считыватель и тип способа входа:
      // одинаковые по написанию UID карты и ID отпечатка не должны схлопываться в один дедуп)
      const dedupeKey = `${nameEspReader}:${credential_type}:${scannedValue}`;
      if (processingCards.has(dedupeKey)) {
        return console.log(`[MQTT] Duplicate ignored for ${dedupeKey}`);
      }
      processingCards.set(dedupeKey, Date.now());

      try {
        // --- BUSINESS LOGIC ---
        const decision = await processAccessLogic({
          scannedValue, credentialType: credential_type, isEntering, readerId: nameEspReader,
          state, User, AccessLog, Credential,
        });

        routeDecision(client, state, reader, decision, scannedValue);

      } catch (err) {
        console.error('[MQTT] Processing Error:', err);
        // Ошибка уходит только считывателю, замки не трогаем
        publishToDevice(client, reader.deviceId, buildPayload(MQTT_RESPONSE.ERROR, scannedValue, reader.deviceId));
      } finally {
        setTimeout(() => processingCards.delete(dedupeKey), PROCESSING_TTL_MS);
      }
    }
  });

  return client;
}



/**
 * Находит пользователя по отсканированному значению.
 *
 * "card" - как и раньше, напрямую по User.user_id (основная карта). Это сохраняет 100%
 * совместимость со старой прошивкой считывателей карт: ни формат, ни поведение не изменились.
 *
 * Любой другой тип ("fingerprint" и далее) - через коллекцию Credential, которая связывает
 * произвольный идентификатор (например, ID отпечатка в памяти сенсора) с уже существующим
 * пользователем. Привязка делается один раз через админку (POST /api/users/:id/credentials),
 * а не автоматически через режим добавления карт - у "голого" скана отпечатка нет имени,
 * которое можно было бы присвоить новому пользователю, поэтому для отпечатка всегда нужен
 * заранее существующий пользователь.
 */
async function resolveUser(credentialType, value, User, Credential) {
  if (credentialType === 'card') {
    return User.findOne({ user_id: value }).lean();
  }
  const cred = await Credential.findOne({ type: credentialType, value }).lean();
  if (!cred) return null;
  return User.findOne({ _id: cred.user }).lean();
}

/**
 * Ядро логики доступа.
 */
async function processAccessLogic({ scannedValue, credentialType, isEntering, readerId, state, User, AccessLog, Credential }) {
  const now = new Date();

  // Режим добавления карт определяется ТОЛЬКО сервером.
  // Если задан state.addingCardReaderId, карты регистрирует только эта считывающая ESP.
  // Работает только для credentialType === 'card': создать нового пользователя по "голому"
  // отпечатку нельзя (см. комментарий к resolveUser), для отпечатка нужна привязка через админку.
  const addingCardMode =
    credentialType === 'card' &&
    Boolean(state.isAddingCardBool) &&
    (!state.addingCardReaderId || state.addingCardReaderId === readerId);

  // 1. РЕЖИМ ДОБАВЛЕНИЯ КАРТ
  if (addingCardMode) {
    const exists = await User.findOne({ user_id: scannedValue }).lean();
    if (!exists) {
      await User.create({ user_id: scannedValue, name: `Card ${scannedValue.slice(-4)}` });
      return MQTT_RESPONSE.REGISTERED;
    }
    return MQTT_RESPONSE.ALREADY_REGISTERED;
  }

  // 2. ЧРЕЗВЫЧАЙНАЯ СИТУАЦИЯ
  if (state.isEmergencyBool) {
    await AccessLog.create({ user_id: scannedValue, isEntry: isEntering, access: true, reason: 'EMERGENCY', timestamp: now, credentialType });
    // В ЧС счетчик не меняем или меняем? Обычно в ЧС двери открыты для всех, счетчик не важен.
    // Если нужно менять: state.counterCurrentUsersNow += isEntering ? 1 : -1;
    return MQTT_RESPONSE.EMERGENCY;
  }

  // 3. ПОЛЬЗОВАТЕЛЬ
  const user = await resolveUser(credentialType, scannedValue, User, Credential);
  if (!user) {
    console.log("DENIED_UNKNOWN");
    await AccessLog.create({ user_id: scannedValue, isEntry: isEntering, access: false, reason: 'DENIED_UNKNOWN', timestamp: now, credentialType });
    return MQTT_RESPONSE.DENIED_UNKNOWN;
  }

  // Канонический идентификатор человека - его основная карта (User.user_id), а не то, чем он
  // в этот раз отсканировался. Это критично: если один и тот же человек входит картой, а
  // выходит отпечатком, антипассбэк и счётчик должны видеть ОДНОГО человека, а не двух разных
  // "user_id" в журнале. С единственным способом входа (только карта) это ничего не меняет -
  // canonicalId всегда совпадает с тем, что сканировалось.
  const canonicalId = user.user_id;

  // 4. ЛИМИТ МЕСТ (Только на вход)
  if (isEntering && state.isLimitWorking && state.counterCurrentUsersNow >= state.usersLimit) {
    console.log("DENIED_LIMIT");
    await AccessLog.create({ user_id: canonicalId, isEntry: true, access: false, reason: 'DENIED_LIMIT', timestamp: now, credentialType });
    return MQTT_RESPONSE.DENIED_LIMIT;
  }

  // 5. АНТИПАССБЭК (Последний УСПЕШНЫЙ лог, по каноническому id - не зависит от способа входа)
  const lastLog = await AccessLog.findOne({ user_id: canonicalId, access: true }).sort({ timestamp: -1 }).lean();

  if (lastLog) {
    if (isEntering && lastLog.isEntry) return MQTT_RESPONSE.DENIED_INSIDE;       // Уже внутри
    if (!isEntering && !lastLog.isEntry) return MQTT_RESPONSE.DENIED_OUTSIDE;   // Уже снаружи
  } else if (!isEntering) {
    console.log("DENIED_NO_ENTRY");
    return MQTT_RESPONSE.DENIED_NO_ENTRY; // Выход без входа
  }

  // 6. ГРАФИК СМЕН
  if (!isWorkShiftStarted(user.startWorkDay, user.endWorkDay, now)) {
    console.log(`Denied shift`);
    await AccessLog.create({ 
      user_id: canonicalId, 
      isEntry: isEntering, 
      access: false, 
      reason: 'DENIED_SHIFT', 
      timestamp: now 
    });
    return MQTT_RESPONSE.DENIED_SHIFT;
  }

  // 7. РАЗРЕШЕНО
  state.counterCurrentUsersNow += isEntering ? 1 : -1;
  if (state.counterCurrentUsersNow < 0) state.counterCurrentUsersNow = 0;

  console.log(`ALLOWED`);

  // Запись лога УСПЕХА
  await AccessLog.create({
    user_id: canonicalId,
    isEntry: isEntering,
    access: true,
    reason: 'ALLOWED',
    timestamp: now,
    credentialType,
  });

  console.log(new Date().getTime());

  // Расчет рабочего времени (При выходе)
  if (!isEntering && lastLog) {
    const entryTime = new Date(lastLog.timestamp).getTime();
    const durationMs = now.getTime() - entryTime;
    if (durationMs > 0 && durationMs < 24 * 60 * 60 * 1000) { // Защита от багов времени (>24h)
      await User.updateOne(
        { user_id: canonicalId },
        { $inc: { totalWorkMs: durationMs } }
      );

      const totalWorkMsDoc = await User.findOne({ user_id: canonicalId }, { totalWorkMs: 1 }).lean();
      console.log(`Updated totalWorkMs for ${canonicalId}: ${totalWorkMsDoc.totalWorkMs} ms`);
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
 * Должно ли КОНКРЕТНОЕ устройство видеть режим добавления карт/отпечатков.
 *
 * Если addingCardReaderId не задан (выбрано "любой одобренный" в панели) - видят все одобренные
 * устройства, как и раньше.
 *
 * Если задан конкретный считыватель - видят только он сам и замки из его targets. Остальные
 * считыватели и замки продолжают работать как обычно: через них по-прежнему можно пройти,
 * пока идёт регистрация на другом считывателе - это и есть смысл выбора конкретного устройства
 * в панели, а не просто индикация "для галочки".
 */
function deviceSeesAddingCard(state, dev) {
  if (!state.isAddingCardBool) return false;
  if (!state.addingCardReaderId) return true; // "любой одобренный"
  if (dev.deviceId === state.addingCardReaderId) return true;
  const reader = state.devices.get(state.addingCardReaderId);
  return Boolean(reader && reader.targets.includes(dev.deviceId));
}

/**
 * Статус одному устройству (retain=true, чтобы получить его сразу после подписки).
 * Неодобренные и заблокированные устройства всегда видят "всё выключено":
 * ЧС и режим добавления карт их не касаются. Режим добавления карт дополнительно сужается
 * до конкретного считывателя и его замков через deviceSeesAddingCard (см. выше) - ЧС остаётся
 * общим для всех, это не затронуто.
 */
function publishDeviceStatus(client, state, dev, isEmergency) {
  if (!client?.connected || !dev) return;
  const approved = dev.status === 'approved';
  client.publish(TOPIC.deviceStatus(dev.deviceId), JSON.stringify({
    isEmergency: approved && Boolean(isEmergency),
    isAddingCard: approved && deviceSeesAddingCard(state, dev),
  }), { qos: 1, retain: true });
}

function clearDeviceStatus(client, deviceId) {
  if (!client?.connected) return;
  client.publish(TOPIC.deviceStatus(deviceId), '', { retain: true });
}

/** Рассылка статуса системы (ЧС, режим карт) всем известным устройствам */
export function broadcastSystemStatus(client, state) {
  if (!client?.connected || !state.devices) return;

  for (const dev of state.devices.values()) {
    publishDeviceStatus(client, state, dev, state.isEmergencyBool);
  }
  console.log(`[MQTT] Broadcast Status: Emergency=${state.isEmergencyBool}, AddingCard=${state.isAddingCardBool}, scopedTo=${state.addingCardReaderId || 'все одобренные'}`);
}

/** Записывает последний известный статус регистрации для конкретного пользователя (для панели) */
function setEnrollStatus(state, userId, status, message, isProgress = false) {
  const key = String(userId);
  const prev = state.enrollStatus.get(key);
  const progress = [...(prev?.progress ?? [])];
  if (isProgress) progress.push(message);
  state.enrollStatus.set(key, { status, message, progress, updatedAt: Date.now() });
}

/** Читает статус регистрации для панели. Возвращает 'idle', если сессии не было или она устарела. */
export function getEnrollStatus(state, userId) {
  const s = state.enrollStatus.get(String(userId));
  if (!s) return { status: 'idle', progress: [] };
  return { status: s.status, message: s.message, progress: s.progress };
}

/**
 * Запускает регистрацию отпечатка на устройстве полностью по MQTT - никакого провода,
 * никакого ключа администратора на самой плате. Вызывается из роута панели администратора.
 *
 * Возвращает { ok: true, fingerprintId } при успешной отправке команды, или
 * { ok: false, error } если устройство не годится для регистрации прямо сейчас
 * (не найдено, не одобрено, не online, уже идёт другая регистрация на этом устройстве).
 */
export async function requestFingerprintEnrollment(client, state, Credential, deviceId, userId) {
  const dev = state.devices.get(deviceId);
  if (!dev || dev.status !== 'approved' || dev.role !== 'reader') {
    return { ok: false, error: 'Устройство не найдено или не одобрено' };
  }
  if (!dev.online) {
    return { ok: false, error: 'Устройство сейчас не на связи' };
  }
  if (state.pendingEnrollments.has(deviceId)) {
    return { ok: false, error: 'На этом устройстве уже идёт другая регистрация' };
  }
  if (!client?.connected) {
    return { ok: false, error: 'Нет связи с MQTT-брокером' };
  }

  const used = await Credential.find({ type: 'fingerprint' }, { value: 1 }).lean();
  const fingerprintId = used.reduce((m, c) => {
    const n = Number(c.value);
    return Number.isInteger(n) && n > m ? n : m;
  }, 0) + 1;

  state.pendingEnrollments.set(deviceId, { userId, fingerprintId, requestedAt: Date.now() });
  state.enrollStatus.delete(String(userId));
  setEnrollStatus(state, userId, 'waiting', `Ожидаем сканирование на устройстве (номер ${fingerprintId})`);
  client.publish(TOPIC.deviceEnrollCmd(deviceId), JSON.stringify({ fingerprintId }), { qos: 1 });
  console.log(`[MQTT] Enrollment requested on ${deviceId}: fingerprintId=${fingerprintId}, user=${userId}`);

  return { ok: true, fingerprintId };
}
