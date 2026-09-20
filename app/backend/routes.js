// backend/routes.js
import { z } from 'zod';
import { asyncHandler, validate, requireApiKey } from './middleware.js';

const userIdSchema = z.string().min(1).max(64);
const nonNegativeInt = z.number().int().nonnegative();
const idParamSchema = z.object({
  id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid ObjectId')
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
}).strict();

// --- ПРИНИМАЕМ state КАК 3-Й АРГУМЕНТ ---
export function registerRoutes(app, models, state) {
  const { User, AccessLog, Device } = models;

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
    req.app.locals.broadcastStatus(state.isEmergencyBool, state.isAddingCardBool);
    res.json({ isAddingCard: state.isAddingCardBool, readerId: state.addingCardReaderId });
  }));

  app.post('/api/emergency-situation', requireApiKey, validate(boolSchema), asyncHandler(async (req, res) => {
    state.isEmergencyBool = req.body.value;
    req.app.locals.broadcastStatus(state.isEmergencyBool, state.isAddingCardBool);
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
    const { page, limit } = req.query;
    const skip = (page - 1) * limit;
    const [users, total] = await Promise.all([
      User.find().sort({ created_at: -1 }).skip(skip).limit(limit).lean(),
      User.countDocuments()
    ]);
    res.json({ data: users, page, limit, total, pages: Math.ceil(total / limit) });
  }));

  app.post('/api/users', requireApiKey, validate(createUserSchema), asyncHandler(async (req, res) => {
    const user = new User(req.body);
    await user.save();
    res.status(201).json(user);
  }));

  app.delete('/api/users/:id', requireApiKey, validate(idParamSchema, 'params'), asyncHandler(async (req, res) => {
    const deleted = await User.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'User not found' });
    res.json({ message: 'User deleted' });
  }));

  // Logs
  app.get('/api/data', requireApiKey, validate(paginationSchema, 'query'), asyncHandler(async (req, res) => {
    const { page, limit } = req.query;
    const skip = (page - 1) * limit;
    const [logs, total] = await Promise.all([
      AccessLog.find().sort({ timestamp: -1 }).skip(skip).limit(limit).lean(),
      AccessLog.countDocuments()
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