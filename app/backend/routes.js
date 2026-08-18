// backend/routes.js
import { z } from 'zod';
import { asyncHandler, validate, requireApiKey } from './middleware.js';

const userIdSchema = z.string().min(1).max(64);
const nonNegativeInt = z.number().int().nonnegative();
const idParamSchema = z.object({
  id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid ObjectId')
}).strict();

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

const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(500).default(100),
}).strict();

// --- ПРИНИМАЕМ state КАК 3-Й АРГУМЕНТ ---
export function registerRoutes(app, models, state) {
  const { User, AccessLog } = models;

  // ==========================================
  // PUBLIC / DEVICE STATUS
  // ==========================================
  app.get('/api/adding-card', (req, res) => res.json({ isAddingCard: state.isAddingCardBool }));
  app.get('/api/hardware-status', (req, res) => res.json({ isEmergency: state.isEmergencyBool }));

  app.get('/api/connection-to-server', asyncHandler(async (req, res) => {
    const now = Date.now();
    const timeout = 20000;
    // Читаем напрямую из замыкания state
    const connectedCard = state.StatusCardModuleConnection && (now - state.currentTimeCard <= timeout);
    const connectedLock = state.StatusMainLockModuleConnection && (now - state.currentTimeLock <= timeout);
    res.json({ connected: connectedCard, connectedLock: connectedLock });
  }));

  // ==========================================
  // ADMIN API (requireApiKey middleware)
  // ==========================================
  // System Control
  app.post('/api/adding-card', requireApiKey, validate(boolSchema), asyncHandler(async (req, res) => {
    state.isAddingCardBool = req.body.value;
    req.app.locals.broadcastStatus(state.isEmergencyBool, state.isAddingCardBool);
    res.json({ isAddingCard: state.isAddingCardBool });
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
      totalWorkHours: Number((u.totalWorkMs / 3_600_000).toFixed(2)),
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