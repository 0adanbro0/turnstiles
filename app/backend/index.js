require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();

app.use(cors({
  origin: [
    'http://localhost:5173', // Allows React (Vite) to connect
    'http://127.0.0.1:5173',
    'http://localhost',
    'http://127.0.0.1',
    'http://10.142.165.220'
  ]
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const mongoUri = process.env.mongo_url || 'mongodb://admin:password123@db:27017/access_db?authSource=admin';
let usersLimit = 250;
let counterCurrentUsersNow = 0; // Current number of people inside the building
let isLimitWorking = false
let isEmergencyBool = false;

mongoose.connect(mongoUri)
  .then(() => {
    console.log('Connected to MongoDB');
    mongoose.model('AccessLog').schema.index({ user_id: 1, access: 1, timestamp: -1 });
    mongoose.model('User').schema.index({ user_id: 1 });
  })
  .catch(err => console.error('MongoDB connection error:', err));


const UserSchema = new mongoose.Schema({
  user_id: { type: String, required: true, unique: true },
  name: { type: String, default: 'User' },
  created_at: { type: Date, default: Date.now },
  totalWorkMs: { type: Number, default: 0 } 
}, { versionKey: false });
const User = mongoose.model('User', UserSchema);

const LogSchema = new mongoose.Schema({
  user_id: { type: String, required: true },
  isEntry: { type: Boolean, default: true },
  timestamp: { type: Date, default: Date.now },
  access: { type: Boolean, default: false },
}, { versionKey: false });
const AccessLog = mongoose.model('AccessLog', LogSchema);

// --- ROUTES ---

// ESP32 sends a request here when someone scans a card
app.post('/api/check', async (req, res) => {
  try {
    const { user_id, direction } = req.body; 
    
    if (!user_id) {
      console.log('Access denied: empty user_id received');
      return res.status(400).send("0");
    }

    const userIdStr = String(user_id);
    const isEntering = direction === 'in';

    // 1. Check if user exists in database
    const userExists = await User.findOne({ user_id: userIdStr });
    if (!userExists) {
      console.log(`Access denied [unknown card]: ${userIdStr}`);
      await new AccessLog({ user_id: userIdStr, isEntry: isEntering, access: false }).save();
      return res.send("404"); // 404 = Unknown card
    }

    // 2. Check if the building is full (Only blocks entry, exit is always allowed)
    if (isEntering && isLimitWorking && counterCurrentUsersNow >= usersLimit) {
      console.log(`Access denied [Limit reached: ${usersLimit}]: ${userIdStr}`);
    
      new AccessLog({ user_id: userIdStr, isEntry: true, access: false }).save()
        .catch(err => console.error("Ошибка сохранения лога отказа:", err));
        
      return res.send("422");
    }

    // 3. Anti-passback: prevent scanning same card twice for entry or exit
    const lastSuccessfulLog = await AccessLog.findOne({ user_id: userIdStr, access: true })
      .sort({ timestamp: -1 });

    if (lastSuccessfulLog) {
      if (isEntering && lastSuccessfulLog.isEntry === true) {
        console.log(`Access denied [already inside]: ${userIdStr}`);
        await new AccessLog({ user_id: userIdStr, isEntry: true, access: false }).save();
        return res.send("0");
      }
      if (!isEntering && lastSuccessfulLog.isEntry === false) {
        console.log(`Access denied [already outside]: ${userIdStr}`);
        await new AccessLog({ user_id: userIdStr, isEntry: false, access: false }).save();
        return res.send("0");
      }
    } else {
      if (!isEntering) {
        console.log(`Access denied [exit without entry]: ${userIdStr}`);
        await new AccessLog({ user_id: userIdStr, isEntry: false, access: false }).save();
        return res.send("0");
      }
    }

    // 4. Update the live counter instantly
    if (isEntering) {
      counterCurrentUsersNow += 1;
    } else {
      counterCurrentUsersNow = Math.max(0, counterCurrentUsersNow - 1);
    }

    console.log(`Access allowed [${direction}]: ${userExists.name}. Inside: ${counterCurrentUsersNow}/${usersLimit}`);
    
    // Save successful entry/exit log
    const currentLog = new AccessLog({ 
      user_id: userIdStr, 
      isEntry: isEntering,
      access: true
    });
    currentLog.save().catch(err => console.error("Ошибка фонового сохранения лога:", err));

    // 5. Calculate and add work time when user exits the building
    if (!isEntering && lastSuccessfulLog) {
      const entryTime = new Date(lastSuccessfulLog.timestamp);
      const exitTime = new Date(currentLog.timestamp);
      const durationMs = exitTime - entryTime;

      if (durationMs > 0) {
        await User.updateOne(
          { user_id: userIdStr },
          { $inc: { totalWorkMs: durationMs } } // Atomic update to prevent race conditions
        );
        console.log(`Added time for user ${userExists.name}: ${Math.round(durationMs / 1000)} sec.`);
      }
    }
    
    return res.send("1"); // 1 = Access allowed

  } catch (err) {
    console.error("CRITICAL SERVER ERROR IN /api/check:", err);
    return res.status(500).send("0");
  }
});

app.get('/api/hardware-status', (req, res) => {
  try {
    // Если ЧС активна — отправляем "1", иначе "0"
    if (isEmergencyBool) {
      return res.send(true);
    } else {
      return res.send(false);
    }
  } catch (err) {
    return res.status(500).send("0");
  }
});

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

// Updates max limit and synchronizes counter from the frontend
app.post('/api/set-users-limit', async (req, res) => {
  try {
    const usersLimitParam = req.body.limitUsers;
  
    if (usersLimitParam !== undefined && usersLimitParam !== null) {
      usersLimit = usersLimitParam;

      if (usersLimit === 0) {
        isLimitWorking = false;
      } else {
        isLimitWorking = true;
      }
    }
    
    if (req.body.counterInUsers !== undefined) {
      counterCurrentUsersNow = req.body.counterInUsers;
    }

    res.status(200).json({ 
      currentLimit: usersLimit, 
      currentCounterInUsers: counterCurrentUsersNow,
      isLimitWorking: isLimitWorking
    });
  } catch (err) {
    res.status(500).json({ error: 'set users limit error' });
  }
});

app.post('/api/emergency-situation', async (req, res) => {
  try {
    const isEmergency = req.body.isEmergency;

    if (typeof isEmergency !== 'boolean') {
      return res.status(400).json({ error: 'Data format error' });
    }
    
    isEmergencyBool = isEmergency;
    res.status(200).json({ 
      isEmergency: isEmergency
    });
  } catch (err) {
    res.status(500).json({ error: 'set users limit error' });
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
    res.status(500).json({ error: 'Get history error' });
  }
});

app.delete('/api/data/:id', async (req, res) => {
  try {
    await AccessLog.findByIdAndDelete(req.params.id);
    res.json({ message: 'Log deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Delete log error' });
  }
});

app.get('/api/users/work-time', async (req, res) => {
  try {
    const users = await User.find().lean();

    const workTimeReport = users.map(user => {
      const totalMs = user.totalWorkMs || 0;
      const totalSeconds = Math.round(totalMs / 1000);

      return {
        _id: user._id,
        user_id: user.user_id,
        name: user.name,
        created_at: user.created_at,
        totalWorkHours: totalSeconds 
      };
    });

    res.json(workTimeReport);
  } catch (err) {
    console.error("Calculation error:", err);
    res.status(500).json({ error: 'Calculate work time error' });
  }
});

app.post('/api/users/reset-time', async (req, res) => {
  try {
    const { user_id } = req.body;

    if (user_id) {
      await User.updateOne({ user_id: String(user_id) }, { $set: { totalWorkMs: 0 } });
      return res.json({ message: `Work time for user ${user_id} was reset` });
    } else {
      await User.updateMany({}, { $set: { totalWorkMs: 0 } });
      return res.json({ message: 'Work time for all users was reset' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Reset time error' });
  }
});

// Clears all logs and resets the inside-building counter for the next day
app.delete('/api/data-all', async (req, res) => {
  counterCurrentUsersNow = 0; 
  try {
    await AccessLog.deleteMany({});
    console.log('Day finished: all logs cleared');
    res.json({ message: 'Day finished' });
  } catch (err) {
    res.status(500).json({ error: 'Day finish error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port: ${PORT}`);
});
