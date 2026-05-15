require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

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
  created_at: { type: Date, default: Date.now }
}, { versionKey: false });
const User = mongoose.model('User', UserSchema);

const LogSchema = new mongoose.Schema({
  user_id: { type: String, required: true },
  isEntry: { type: Boolean, default: true },
  timestamp: { type: Date, default: Date.now },
  access: {type:Boolean, default: false}
}, { versionKey: false });
const AccessLog = mongoose.model('AccessLog', LogSchema);

// Esp32 routes
app.post('/api/check', async (req, res) => {
  try {
    const { user_id, direction} = req.body; 
    
    if (!user_id) {
      console.log('get empty result without user_id');
      return res.status(400).send("0");
    }

    // 1. Cheking users including
    const userExists = await User.findOne({ user_id });
    const isAllowed = !!userExists;

    if (isAllowed) {
      console.log(`access is allowed [${direction}]: ${user_id}`);
    } else {
      console.log(`access is denied [unknown card]: ${user_id}`);
    }

    await new AccessLog({ 
      user_id: String(user_id), 
      isEntry: direction === 'in',
      access: isAllowed ? 1 : 0
    }).save();
    
    return res.send(isAllowed ? "1" : "0");

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
