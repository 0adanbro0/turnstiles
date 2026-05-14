const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();

// Настройки парсеров (обрабатывают и JSON, и формы)
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Подключение к БД
const mongoUri = process.env.MONGO_URI || 'mongodb://admin:password123@db:27017/access_db?authSource=admin';

mongoose.connect(mongoUri)
  .then(() => console.log('✅ Подключено к MongoDB'))
  .catch(err => console.error('❌ Ошибка подключения:', err));

// --- МОДЕЛИ ДАННЫХ ---

const UserSchema = new mongoose.Schema({
  user_id: { type: String, required: true, unique: true },
  name: { type: String, default: 'Пользователь' },
  created_at: { type: Date, default: Date.now }
}, { versionKey: false });
const User = mongoose.model('User', UserSchema);

const LogSchema = new mongoose.Schema({
  user_id: { type: String, required: true },
  isEntry: { type: Boolean, default: true },
  timestamp: { type: Date, default: Date.now }
}, { versionKey: false });
const AccessLog = mongoose.model('AccessLog', LogSchema);

// --- ОБНОВЛЕННЫЙ РОУТ ДЛЯ ESP32 ---
app.post('/api/check', async (req, res) => {
  try {
    const { user_id, direction } = req.body; 
    
    if (!user_id) {
      console.log('⚠️ Получен пустой запрос без user_id');
      return res.status(400).send("0");
    }

    // Ищем пользователя в базе данных
    const userExists = await User.findOne({ user_id });

    // ЗАПИСЬ В БД ПРОИСХОДИТ ВСЕГДА (даже если пользователя нет в системе)
    await new AccessLog({ 
      user_id: String(user_id), 
      isEntry: direction === 'in' 
    }).save();
    
    if (userExists) {
      console.log(`🔓 Доступ РАЗРЕШЕН [${direction === 'in' ? 'Вход' : 'Выход'}]: ${user_id}`);
      return res.send("1"); 
    } else {
      console.log(`🔒 Доступ ОТКЛОНЕН [Неизвестная карта]: ${user_id}`);
      return res.send("0");
    }
  } catch (err) {
    console.error("❌ Ошибка сервера:", err);
    res.status(500).send("0");
  }
});

// --- РОУТЫ ДЛЯ ФРОНТЕНДА ---

app.get('/api/users', async (req, res) => {
  try {
    const users = await User.find().sort({ created_at: -1 });
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка получения пользователей' });
  }
});

app.post('/api/users', async (req, res) => {
  try {
    const newUser = new User(req.body);
    await newUser.save();
    res.status(201).json(newUser);
  } catch (err) {
    res.status(400).json({ error: 'Ошибка: ID уже существует или данные неверны' });
  }
});

app.delete('/api/users/:id', async (req, res) => {
  try {
    await User.findByIdAndDelete(req.params.id);
    res.json({ message: 'Пользователь удален' });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка при удалении' });
  }
});

app.get('/api/data', async (req, res) => {
  try {
    const logs = await AccessLog.find().sort({ timestamp: -1 });
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка получения истории' });
  }
});

app.delete('/api/data/:id', async (req, res) => {
  try {
    await AccessLog.findByIdAndDelete(req.params.id);
    res.json({ message: 'Запись удалена' });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка удаления записи' });
  }
});

app.delete('/api/data-all', async (req, res) => {
  try {
    await AccessLog.deleteMany({});
    console.log('🗑️ Вся история очищена');
    res.json({ message: 'Вся история успешно удалена' });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка при полной очистке' });
  }
});

const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
