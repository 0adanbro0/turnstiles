const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();

// 1. Настройки (Middleware)
app.use(cors());         // Чтобы React мог достучаться до бэкенда
app.use(express.json()); // Чтобы сервер понимал JSON от ESP32 и React

// 2. Подключение к MongoDB 
// Берем URL из переменной окружения, которую ты прописал в docker-compose
const mongoUri = process.env.MONGO_URI || 'mongodb://admin:password123@db:27017/access_db?authSource=admin';

mongoose.connect(mongoUri)
  .then(() => console.log('✅ Успешное подключение к MongoDB'))
  .catch(err => console.error('❌ Ошибка подключения к MongoDB:', err));

// 3. Схема и Модель данных
const Turnstiles = new mongoose.Schema({
  user_id: String,
  timestamp: { type: Date, default: Date.now }
});

const TurnstilesData = mongoose.model('TurnstilesData', Turnstiles);

// 4. Роуты (Эндпоинты)

// GET: Отдать данные Фронтенду (последние 50 записей)
app.get('/api/data', async (req, res) => {
  try {
    const data = await TurnstilesData.find().sort({ timestamp: -1 }).limit(50);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка при получении данных' });
  }
});

// POST: Принять данные от ESP32
app.post('/api/data', async (req, res) => {
  try {
    const newData = new TurnstilesData(req.body); // Берем всё, что прислала ESP32
    await newData.save();
    console.log('📡 Данные от ESP32 сохранены:', req.body);
    res.status(201).json({ message: 'Данные сохранены' });
  } catch (err) {
    console.error('❌ Ошибка сохранения:', err);
    res.status(400).json({ error: 'Ошибка валидации данных' });
  }
});

app.delete('/api/data/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Проверка: является ли переданный ID валидным ObjectId
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Неверный формат ID' });
    }

    const deletedItem = await TurnstilesData.findByIdAndDelete(id);

    if (!deletedItem) {
      return res.status(404).json({ error: 'Запись не найдена' });
    }

    console.log(`🗑️ Запись ${id} удалена`);
    res.json({ message: 'Запись успешно удалена' });
  } catch (err) {
    console.error('❌ Ошибка при удалении:', err);
    res.status(500).json({ error: 'Ошибка сервера при удалении' });
  }
});

// 5. Запуск сервера
const PORT = 3000;
// Важно: '0.0.0.0' позволяет принимать запросы из локальной сети (от ESP32)
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Бэкенд запущен на порту ${PORT}`);
});
