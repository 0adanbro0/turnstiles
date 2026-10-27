// backend/routes.js
import { z } from 'zod';
import { asyncHandler, validate, requireApiKey } from './middleware.js';

const userIdSchema = z.string().min(1).max(64);
const nonNegativeInt = z.number().int().nonnegative();
const idParamSchema = z.object({
  id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid ObjectId')
}).strict();
const userAndCredIdParamSchema = z.object({
  id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid user ObjectId'),
  credId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid credential ObjectId'),
}).strict();

// deviceId = MAC / chip ID; те же ограничения, что и в MQTT-модуле (он попадает в имя топика)
const deviceIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_:\-]+$/, 'Invalid deviceId');
const deviceIdParamSchema = z.object({ deviceId: deviceIdSchema }).strict();

const createUserSchema = z.object({
  user_id: userIdSchema,
  name: z.string().max(100).optional(),
  startWorkDay: z.number().int().min(0).max(23).default(6),
  endWorkDay: z.number().int().min(0).max(23).default(18),
  accessLevel: z.string().max(50).default('firstLevel'),
}).strict();

const setLimitSchema = z.object({
  usersLimitParam: nonNegativeInt.optional(),
  counterInUsersParam: nonNegativeInt.optional(),
}).strict();

const resetTimeSchema = z.object({ user_id: userIdSchema.optional() }).strict();
const boolSchema = z.object({ value: z.boolean() }).strict();

const updateUserSchema = z.object({
  name: z.string().max(100).optional(),
  startWorkDay: z.number().int().min(0).max(23).optional(),
  endWorkDay: z.number().int().min(0).max(23).optional(),
  accessLevel: z.string().max(50).optional(),
}).strict().refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' });

// "card" сюда не включаем: основная карта пользователя управляется через сам User.user_id
// (создание/редактирование пользователя), а не через Credential.
const createCredentialSchema = z.object({
  type: z.enum(['fingerprint']),
  value: z.string().min(1).max(128),
}).strict();

// Режим добавления карт: можно ограничить одной читалкой
const addingCardSchema = z.object({
  value: z.boolean(),
  readerId: deviceIdSchema.nullable().optional(),
}).strict();

const updateDeviceSchema = z.object({
  name: z.string().max(100).optional(),
  role: z.enum(['reader', 'lock']).optional(),
  status: z.enum(['pending', 'approved', 'blocked']).optional(),
  targets: z.array(deviceIdSchema).max(20).optional(),
}).strict().refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' });

const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(500).default(100),
  search: z.string().trim().max(100).optional(), // общий текстовый поиск, смысл зависит от роута
  credentialType: z.enum(['card', 'fingerprint']).optional(), // фильтр для журнала
  hasFingerprint: z.enum(['yes', 'no']).optional(),            // фильтр для списка пользователей
}).strict();

// Экранируем спецсимволы regex, чтобы поиск с точкой/скобкой и т.п. не ломал запрос и не вёл себя как regex
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// --- ПРИНИМАЕМ state КАК 3-Й АРГУМЕНТ ---
export function registerRoutes(app, models, state) {
  const { User, AccessLog, Device, Credential } = models;

  // Есть ли хотя бы одно одобренное онлайн-устройство с такой ролью
  const isRoleOnline = (role) =>
    [...state.devices.values()].some((d) => d.role === role && d.status === 'approved' && d.online);

  // ==========================================
  // PUBLIC / DEVICE STATUS
  // ==========================================
  app.get('/api/adding-card', (req, res) => res.json({ isAddingCard: state.isAddingCardBool }));
  app.get('/api/hardware-status', (req, res) => res.json({ isEmergency: state.isEmergencyBool }));

  // Формат ответа сохранён для фронтенда. Роут публичный, поэтому только булевы значения,
  // без имён и id устройств.
  app.get('/api/connection-to-server', asyncHandler(async (req, res) => {
    res.json({
      connected: isRoleOnline('reader'),
      connectedLock: isRoleOnline('lock'),
    });
  }));

  // ==========================================
  // ADMIN API (requireApiKey middleware)
  // ==========================================
  // System Control
  app.post('/api/adding-card', requireApiKey, validate(addingCardSchema), asyncHandler(async (req, res) => {
    const { value, readerId } = req.body;

    if (value && readerId) {
      const reader = state.devices.get(readerId);
      if (!reader || reader.role !== 'reader' || reader.status !== 'approved') {
        return res.status(400).json({ error: 'readerId must be an approved reader' });
      }
    }

    state.isAddingCardBool = value;
    state.addingCardReaderId = value ? (readerId ?? null) : null;
    req.app.locals.broadcastStatus();
    res.json({ isAddingCard: state.isAddingCardBool, readerId: state.addingCardReaderId });
  }));

  app.post('/api/emergency-situation', requireApiKey, validate(boolSchema), asyncHandler(async (req, res) => {
    state.isEmergencyBool = req.body.value;
    req.app.locals.broadcastStatus();
    res.json({ isEmergency: state.isEmergencyBool });
  }));

  app.post('/api/set-users-limit', requireApiKey, validate(setLimitSchema), asyncHandler(async (req, res) => {
    if (req.body.usersLimitParam !== undefined) {
      state.usersLimit = req.body.usersLimitParam;
      state.isLimitWorking = state.usersLimit > 0;
    }
    if (req.body.counterInUsersParam !== undefined) {
      state.counterCurrentUsersNow = req.body.counterInUsersParam;
    }
    res.json({ 
      currentLimit: state.usersLimit, 
      currentCounter: state.counterCurrentUsersNow, 
      isLimitWorking: state.isLimitWorking 
    });
  }));

  // ==========================================
  // DEVICES (реестр считывателей и замков)
  // ==========================================
  // Список с online-статусом. Новые устройства приходят со статусом 'pending'.
  app.get('/api/devices', requireApiKey, asyncHandler(async (req, res) => {
    res.json(req.app.locals.getDevices());
  }));

  // Одобрить / переименовать / назначить роль / задать targets / заблокировать
  app.patch('/api/devices/:deviceId', requireApiKey, validate(deviceIdParamSchema, 'params'), validate(updateDeviceSchema), asyncHandler(async (req, res) => {
    const { deviceId } = req.params;
    const body = { ...req.body };

    const existing = await Device.findOne({ deviceId }).lean();
    if (!existing) return res.status(404).json({ error: 'Device not found' });

    const next = { ...existing, ...body };

    // Нельзя одобрить устройство без роли: сервер не поймёт, что с ним делать
    if (next.status === 'approved' && !next.role) {
      return res.status(400).json({ error: 'Role is required before approving a device' });
    }

    if (body.targets) {
      body.targets = [...new Set(body.targets)];
      if (body.targets.length > 0) {
        if (next.role !== 'reader') {
          return res.status(400).json({ error: 'Targets can be set only for readers' });
        }
        const locksFound = await Device.countDocuments({ deviceId: { $in: body.targets }, role: 'lock' });
        if (locksFound !== body.targets.length) {
          return res.status(400).json({ error: 'Every target must be an existing device with role "lock"' });
        }
      }
    }

    await Device.updateOne({ deviceId }, { $set: body });
    await req.app.locals.reloadDevice(deviceId);

    const updated = req.app.locals.getDevices().find((d) => d.deviceId === deviceId);
    res.json(updated);
  }));

  // Удаление. Если устройство живо, оно зарегистрируется заново как 'pending'.
  // Чтобы запретить навсегда, ставьте status = 'blocked' вместо удаления.
  app.delete('/api/devices/:deviceId', requireApiKey, validate(deviceIdParamSchema, 'params'), asyncHandler(async (req, res) => {
    const { deviceId } = req.params;

    const deleted = await Device.findOneAndDelete({ deviceId });
    if (!deleted) return res.status(404).json({ error: 'Device not found' });

    // Убираем удалённый замок из targets у считывателей
    const affected = await Device.find({ targets: deviceId }).distinct('deviceId');
    if (affected.length > 0) {
      await Device.updateMany({ targets: deviceId }, { $pull: { targets: deviceId } });
    }

    await req.app.locals.reloadDevice(deviceId); // документа уже нет -> уйдёт из кэша
    for (const id of affected) await req.app.locals.reloadDevice(id);

    res.json({ message: 'Device deleted' });
  }));

  // Users CRUD
  app.get('/api/users', requireApiKey, validate(paginationSchema, 'query'), asyncHandler(async (req, res) => {
    const { page, limit, search, hasFingerprint } = req.query;
    const skip = (page - 1) * limit;

    const match = {};
    if (search) {
      // Поиск без учёта регистра по имени, номеру карты и уровню доступа
      const re = new RegExp(escapeRegex(search), 'i');
      match.$or = [{ name: re }, { user_id: re }, { accessLevel: re }];
    }

    // $lookup, чтобы знать про каждого пользователя, привязан ли к нему отпечаток - коллекция
    // Credential отдельная от User, поэтому без агрегации этого не узнать одним запросом.
    const basePipeline = [
      { $match: match },
      {
        $lookup: {
          from: 'credentials',
          let: { uid: '$_id' },
          pipeline: [
            { $match: { $expr: { $and: [{ $eq: ['$user', '$$uid'] }, { $eq: ['$type', 'fingerprint'] }] } } },
            { $limit: 1 },
          ],
          as: 'fp',
        },
      },
      { $addFields: { hasFingerprint: { $gt: [{ $size: '$fp' }, 0] } } },
      { $project: { fp: 0 } },
      ...(hasFingerprint ? [{ $match: { hasFingerprint: hasFingerprint === 'yes' } }] : []),
    ];

    const [users, countRes] = await Promise.all([
      User.aggregate([...basePipeline, { $sort: { created_at: -1 } }, { $skip: skip }, { $limit: limit }]),
      User.aggregate([...basePipeline, { $count: 'total' }]),
    ]);
    const total = countRes[0]?.total || 0;
    res.json({ data: users, page, limit, total, pages: Math.ceil(total / limit) });
  }));

  // Изменение имени, смены и уровня доступа у уже существующего пользователя
  app.patch('/api/users/:id', requireApiKey, validate(idParamSchema, 'params'), validate(updateUserSchema), asyncHandler(async (req, res) => {
    const updated = await User.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true, runValidators: true }).lean();
    if (!updated) return res.status(404).json({ error: 'User not found' });
    res.json(updated);
  }));

  app.post('/api/users', requireApiKey, validate(createUserSchema), asyncHandler(async (req, res) => {
    const user = new User(req.body);
    await user.save();
    res.status(201).json(user);
  }));

  app.delete('/api/users/:id', requireApiKey, validate(idParamSchema, 'params'), asyncHandler(async (req, res) => {
    const deleted = await User.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'User not found' });
    await Credential.deleteMany({ user: req.params.id }); // без этого остались бы висячие привязки отпечатков
    res.json({ message: 'User deleted' });
  }));

  // ==========================================
  // CREDENTIALS (дополнительные способы входа поверх основной карты - напр. отпечаток)
  // ==========================================
  // Следующий свободный номер для регистрации отпечатка. ВАЖНО: это только подсказка для
  // человека, который физически прикладывает палец к сенсорам - сервер не может сам записать
  // отпечаток. Один и тот же номер нужно использовать при регистрации пальца НА ВСЕХ физических
  // сенсорах для этого человека (вход и выход, все турникеты) - иначе сервер не свяжет их между
  // собой. Подсказка просто уменьшает риск случайно выдать один номер двум разным людям.
  app.get('/api/credentials/next-fingerprint-id', requireApiKey, asyncHandler(async (req, res) => {
    const used = await Credential.find({ type: 'fingerprint' }, { value: 1 }).lean();
    const max = used.reduce((m, c) => {
      const n = Number(c.value);
      return Number.isInteger(n) && n > m ? n : m;
    }, 0);
    res.json({ nextId: max + 1 });
  }));

  app.get('/api/users/:id/credentials', requireApiKey, validate(idParamSchema, 'params'), asyncHandler(async (req, res) => {
    const creds = await Credential.find({ user: req.params.id }).sort({ createdAt: -1 }).lean();
    res.json(creds);
  }));

  // Запускает регистрацию отпечатка полностью по MQTT: сервер сам выбирает свободный номер,
  // шлёт команду устройству, человек прикладывает палец на месте у сенсора, устройство
  // отчитывается результатом - сервер сам создаёт привязку. Никакого провода, никакого ключа
  // администратора на плате. Ответ приходит сразу (команда отправлена), а не после завершения -
  // сама регистрация занимает время (палец нужно приложить физически), поэтому панель должна
  // опрашивать GET /api/users/:id/credentials, пока не увидит новую запись.
  app.post('/api/users/:id/credentials/fingerprint/start', requireApiKey, validate(idParamSchema, 'params'), validate(z.object({ deviceId: deviceIdSchema }).strict()), asyncHandler(async (req, res) => {
    const user = await User.findById(req.params.id).lean();
    if (!user) return res.status(404).json({ error: 'User not found' });

    const result = await req.app.locals.requestFingerprintEnrollment(req.body.deviceId, user._id.toString());
    if (!result.ok) return res.status(409).json({ error: result.error });
    res.status(202).json({ started: true, fingerprintId: result.fingerprintId });
  }));

  // Статус текущей/последней сессии регистрации для панели - чтобы не гадать по Serial Monitor,
  // прошла ли регистрация. 'idle' - сессий не было или результат уже устарел.
  app.get('/api/users/:id/credentials/fingerprint/status', requireApiKey, validate(idParamSchema, 'params'), asyncHandler(async (req, res) => {
    res.json(req.app.locals.getEnrollStatus(req.params.id));
  }));

  // Привязка готового идентификатора вручную - запасной путь на случай, если беспроводная
  // регистрация выше недоступна (например, номер отпечатка известен из другого источника).
  app.post('/api/users/:id/credentials', requireApiKey, validate(idParamSchema, 'params'), validate(createCredentialSchema), asyncHandler(async (req, res) => {
    const user = await User.findById(req.params.id).lean();
    if (!user) return res.status(404).json({ error: 'User not found' });

    try {
      const created = await Credential.create({ user: user._id, type: req.body.type, value: req.body.value });
      res.status(201).json(created);
    } catch (err) {
      if (err.code === 11000) {
        return res.status(409).json({ error: 'Этот идентификатор уже привязан к другому пользователю' });
      }
      throw err;
    }
  }));

  app.delete('/api/users/:id/credentials/:credId', requireApiKey, validate(userAndCredIdParamSchema, 'params'), asyncHandler(async (req, res) => {
    const deleted = await Credential.findOneAndDelete({ _id: req.params.credId, user: req.params.id });
    if (!deleted) return res.status(404).json({ error: 'Credential not found' });
    res.json({ message: 'Credential deleted' });
  }));

  // Logs
  app.get('/api/data', requireApiKey, validate(paginationSchema, 'query'), asyncHandler(async (req, res) => {
    const { page, limit, search, credentialType } = req.query;
    const skip = (page - 1) * limit;

    const conditions = [];
    if (search) {
      // Поиск по номеру карты и причине (ALLOWED, DENIED_LIMIT и т.п.); "вход"/"выход" тоже ищем текстом
      const re = new RegExp(escapeRegex(search), 'i');
      const or = [{ user_id: re }, { reason: re }];
      if ('вход'.includes(search.toLowerCase())) or.push({ isEntry: true });
      if ('выход'.includes(search.toLowerCase())) or.push({ isEntry: false });
      conditions.push({ $or: or });
    }
    if (credentialType) conditions.push({ credentialType });

    const filter = conditions.length === 0 ? {} : conditions.length === 1 ? conditions[0] : { $and: conditions };

    const [logs, total] = await Promise.all([
      AccessLog.find(filter).sort({ timestamp: -1 }).skip(skip).limit(limit).lean(),
      AccessLog.countDocuments(filter)
    ]);
    res.json({ data: logs, page, limit, total, pages: Math.ceil(total / limit) });
  }));

  app.delete('/api/data/:id', requireApiKey, validate(idParamSchema, 'params'), asyncHandler(async (req, res) => {
    const deleted = await AccessLog.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Log not found' });
    res.json({ success: true, message: 'Log deleted' });
  }));

  app.delete('/api/data-all', requireApiKey, asyncHandler(async (req, res) => {
    await AccessLog.deleteMany({});
    state.counterCurrentUsersNow = 0; // Сброс счетчика только здесь
    res.json({ message: 'All logs deleted, counter reset' });
  }));

  // Reports
  app.get('/api/users/work-time', requireApiKey, asyncHandler(async (req, res) => {
    const users = await User.find().lean();
    const report = users.map(u => ({
      _id: u._id,
      user_id: u.user_id,
      name: u.name,
      totalWorkHours: u.totalWorkMs,
      totalWorkMs: u.totalWorkMs,
    }));
    res.json(report);
  }));

  app.post('/api/users/reset-time', requireApiKey, validate(resetTimeSchema), asyncHandler(async (req, res) => {
    if (req.body.user_id) {
      await User.updateOne({ user_id: req.body.user_id }, { $set: { totalWorkMs: 0 } });
      return res.json({ message: `Time reset for ${req.body.user_id}` });
    }
    await User.updateMany({}, { $set: { totalWorkMs: 0 } });
    res.json({ message: 'Time reset for all users' });
  }));
}
