import mongoose from 'mongoose';

const UserSchema = new mongoose.Schema({
  user_id: { type: String, required: true, unique: true, index: true },
  name: { type: String, default: '' },
  accessLevel: { type: String, default: 'firstLevel' },
  created_at: { type: Date, default: Date.now },
  totalWorkMs: { type: Number, default: 0 },
  startWorkDay: { type: Number, default: 6, min: 0, max: 23 },
  endWorkDay: { type: Number, default: 18, min: 0, max: 23 },
}, { versionKey: false });

const LogSchema = new mongoose.Schema({
  user_id: { type: String, required: true, index: true },
  isEntry: { type: Boolean, default: true },
  timestamp: { type: Date, default: Date.now, index: -1 },
  access: { type: Boolean, default: false },
  reason: { type: String, default: '' }, // Для аудита: 'ALLOWED', 'DENIED_LIMIT', 'EMERGENCY'...
}, { versionKey: false });

// Составной индекс для быстрого поиска "последний успешный вход"
LogSchema.index({ user_id: 1, access: 1, timestamp: -1 });

export const User = mongoose.model('User', UserSchema);
export const AccessLog = mongoose.model('AccessLog', LogSchema);

export async function connectToMongoDB(uri) {
  // Настройки пула соединений для продакшена
  await mongoose.connect(uri, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  });
  console.log('[MongoDB] Connected successfully');
  
  // Убеждаемся, что индексы созданы (только при старте в dev)
  if (process.env.NODE_ENV !== 'production') {
    await User.syncIndexes();
    await AccessLog.syncIndexes();
  }
}