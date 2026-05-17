require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { type } = require('node:os');

const app = express();

// Parsers
app.use(cors({
  origin: [
    'http://localhost',
    'http://127.0.0.1',
    'http://10.142.165.220' // IP твоего ПК БЕЗ ПОРТА 3000 (ведь фронтенд на 80 порту)
  ]
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// connecting to mongodb
const mongoUri = process.env.mongo_url || 'mongodb://admin:password123@db:27017/access_db?authSource=admin';

mongoose.connect(mongoUri)
  .then(() => console.log('Connected with MongoDB'))
  .catch(err => console.error('Connected server error:', err));

// Data models

const UserSchema = new mongoose.Schema({
  user_id: { type: String, required: true, unique: true },
  name: { type: String, default: 'User' },
  created_at: { type: Date, default: Date.now },
}, { versionKey: false });
const User = mongoose.model('User', UserSchema);

const LogSchema = new mongoose.Schema({
  user_id: { type: String, required: true },
  isEntry: { type: Boolean, default: true },
  timestamp: { type: Date, default: Date.now },
  access: {type:Boolean, default: false},
}, { versionKey: false });
const AccessLog = mongoose.model('AccessLog', LogSchema);

// Esp32 routes
app.post('/api/check', async (req, res) => {
  try {
    const { user_id, direction } = req.body; 
    
    if (!user_id) {
      console.log('get empty result without user_id');
      return res.status(400).send("0");
    }

    // 1. Проверяем существование пользователя
    const userExists = await User.findOne({ user_id });
    if (!userExists) {
      console.log(`access is denied [unknown card]: ${user_id}`);
      // Логируем попытку доступа неизвестной карты
      await new AccessLog({ user_id: String(user_id), isEntry: direction === 'in', access: false }).save();
      return res.send("0");
    }

    // 2. ЗАЩИТА ОТ ПОВТОРНОГО ВХОДА/ВЫХОДА (Anti-passback)
    // Ищем самый последний УСПЕШНЫЙ лог этого пользователя
    const lastSuccessfulLog = await AccessLog.findOne({ user_id, access: true }).sort({ timestamp: -1 });

    if (lastSuccessfulLog) {
      // Если пользователь пытается зайти ('in'), но его последний лог тоже был вход ('in')
      if (direction === 'in' && lastSuccessfulLog.isEntry === true) {
        console.log(`access is denied [already inside]: ${user_id} (${userExists.name})`);
        await new AccessLog({ user_id: String(user_id), isEntry: true, access: false }).save();
        return res.send("0"); // Блокируем турникет
      }

      // Если пользователь пытается выйти ('out'), но его последний лог тоже был выход ('out')
      if (direction === 'out' && lastSuccessfulLog.isEntry === false) {
        console.log(`access is denied [already outside]: ${user_id} (${userExists.name})`);
        await new AccessLog({ user_id: String(user_id), isEntry: false, access: false }).save();
        return res.send("0"); // Блокируем турникет
      }
    } else {
      // Если у пользователя вообще нет логов в базе и он пытается выйти ('out') без единого входа
      if (direction === 'out') {
        console.log(`access is denied [exit without entry]: ${user_id} (${userExists.name})`);
        await new AccessLog({ user_id: String(user_id), isEntry: false, access: false }).save();
        return res.send("0");
      }
    }

    // 3. Если все проверки пройдены — разрешаем доступ
    console.log(`access is allowed [${direction}]: ${user_id} (${userExists.name})`);
    
    await new AccessLog({ 
      user_id: String(user_id), 
      isEntry: direction === 'in',
      access: true
    }).save();
    
    return res.send("1"); // Открываем турникет

  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).send("0");
  }
});

// Frontend routes
app.get('/api/users', async (req, res) => {
  try {
    const users = await User.find().sort({ created_at: -1 });
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'Get users error' });
  }
});

app.post('/api/users', async (req, res) => {
  try {
    const newUser = new User(req.body);
    await newUser.save();
    res.status(201).json(newUser);
  } catch (err) {
    res.status(500).json({ error: 'Create user error' });
  }
});

app.delete('/api/users/:id', async (req, res) => {
  try {
    await User.findByIdAndDelete(req.params.id);
    res.json({ message: 'User deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Delete user error' });
  }
});

app.get('/api/data', async (req, res) => {
  try {
    const logs = await AccessLog.find().sort({ timestamp: -1 });
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: 'get history error' });
  }
});

app.delete('/api/data/:id', async (req, res) => {
  try {
    await AccessLog.findByIdAndDelete(req.params.id);
    res.json({ message: 'Запись удалена' });
  } catch (err) {
    res.status(500).json({ error: 'delete note error' });
  }
});

app.get('/api/users/work-time', async (req, res) => {
  try {
    const users = await User.find().lean();
    const logs = await AccessLog.find().sort({ timestamp: 1 }).lean();

    console.log(`=== ТЕСТ АНАЛИТИКИ ===`);
    console.log(`Всего пользователей в базе: ${users.length}`);
    console.log(`Всего логов в базе: ${logs.length}`);

    const workTimeReport = users.map(user => {
      // Фильтруем В СЕ лог и пользователя (и успешные, и неуспешные для теста)
      const userLogs = logs.filter(log => String(log.user_id) === String(user.user_id));
      
      console.log(`Пользователь: ${user.name} (ID: ${user.user_id}). Найдено логов: ${userLogs.length}`);
      if (userLogs.length > 0) {
        console.log(`Пример первого лога пользователя:`, {
          access: userLogs[0].access,
          isEntry: userLogs[0].isEntry,
          timestamp: userLogs[0].timestamp
        });
      }

      let totalMs = 0;
      let lastIn = null;

      userLogs.forEach(log => {
        // Проверяем строго булево true ИЛИ число 1 (на случай если база сохранила 1)
        const isAccessGranted = log.access === true || log.access === 1;

        if (isAccessGranted) {
          if (log.isEntry) {
            if (lastIn === null) lastIn = new Date(log.timestamp);
          } else {
            if (lastIn !== null) {
              totalMs += (new Date(log.timestamp) - lastIn);
              lastIn = null;
            }
          }
        }
      });

      // Переводим в секунды для теста, чтобы заметить даже быстрый проход!
      const totalSeconds = Math.round(totalMs / 1000);
      console.log(`Итого насчитано секунд для ${user.name}: ${totalSeconds} сек.`);

      return {
        _id: user._id,
        user_id: user.user_id,
        name: user.name,
        created_at: user.created_at,
        totalWorkHours: totalSeconds // Временно возвращаем СЕКУНДЫ для теста
      };
    });

    res.json(workTimeReport);
  } catch (err) {
    console.error("Calculation error:", err);
    res.status(500).json({ error: 'Calculate work time error' });
  }
});


app.delete('/api/data-all', async (req, res) => {
  try {
    await AccessLog.deleteMany({});
    console.log('Day finished');
    res.json({ message: 'Day finished' });
  } catch (err) {
    res.status(500).json({ error: 'Day finish error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is working on port: ${PORT}`);
});
