require('dotenv').config();
const express = require('express');
const cors = require('cors');

const { connectToMongoDB, User, AccessLog } = require('./database');
const { connectToMQTTClient, broadcastSystemStatus } = require('./clientMQTT');

const app = express();

app.use(cors({
  origin: [
    'http://localhost:5173', // Allows React to connect
    'http://127.0.0.1:5173',
    'http://localhost',
    'http://127.0.0.1',
    'http://10.142.165.220'
  ]
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const mongoUri = process.env.mongo_url || 'mongodb://admin:password123@db:27017/access_db?authSource=admin';
const mqttUri = process.env.MQTT_HOST || 'mqtt://mosquitto:1883'; // url for Docker-broker

const state = {
  usersLimit: 250,
  counterCurrentUsersNow: 0,
  isLimitWorking: false,
  isEmergencyBool: false,
  isAddingCardBool: false,
  currentTimeCard: Date.now(),
  currentTimeLock: Date.now(),
  StatusCardModuleConnection: false,
  StatusMainLockModuleConnection: false,
};

connectToMongoDB(mongoUri).then(() => {
  
  // put info to MQTT client
  connectToMQTTClient(mqttUri, { User, AccessLog }, state);

  // API ROUTES FRONTEND

  app.get('/api/adding-card', (req, res) => res.send(isAddingCardBool));
  app.get('/api/hardware-status', (req, res) => res.send(isEmergencyBool));

  // update status connection from esp
  app.get('/api/connection-to-server', async (req, res) => {
    try {
      if (!state.currentTimeCard || Date.now() - state.currentTimeCard > 5000) {
        state.StatusCardModuleConnection = false; 
      }
      if(!state.currentTimeLock || Date.now() - state.currentTimeLock > 5000){
        state.StatusMainLockModuleConnection = false;
      }
      res.json({ connected: state.StatusCardModuleConnection, connectedLock: state.StatusMainLockModuleConnection });
    } catch (err) {
      console.error("Error in connection-to-server route:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Routes managing from react
  app.post('/api/adding-card', async (req, res) => {
    try {
      const isAddingCard = req.body.isAddingCard;
      if (typeof isAddingCard !== 'boolean') {
        return res.status(400).json({ error: 'Data format error. Expected boolean.' });
      }
      
      state.isAddingCardBool = isAddingCard;
      
      broadcastSystemStatus(state.isEmergencyBool, state.isAddingCardBool); 
      
      console.log(`[API] Режим добавления карт изменен на: ${state.isAddingCardBool}`);
      res.status(200).json({ isAddingCard: state.isAddingCardBool });
    } catch (err) {
      console.error("Error in post /api/adding-card:", err);
      res.status(500).json({ error: 'server error' });
    }
  });

  app.post('/api/emergency-situation', async (req, res) => {
    try {
      const isEmergency = req.body.isEmergency;
      if (typeof isEmergency !== 'boolean') {
        return res.status(400).json({ error: 'Data format error. Expected boolean.' });
      }

      state.isEmergencyBool = isEmergency;
      
      broadcastSystemStatus(state.isEmergencyBool, state.isAddingCardBool); 
      
      console.log(`[API] Режим ЧС успешно изменен на: ${state.isEmergencyBool}`);
      res.status(200).json({ isEmergency: state.isEmergencyBool });
    } catch (err) {
      console.error("Error in post /api/emergency-situation:", err);
      res.status(500).json({ error: 'server error' });
    }
  });

  // Routes for managing users
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
      res.status(500).json({ error: 'Get history error' });
    }
  });

  // Deleting user from database all users
  app.delete('/api/data/:id', async (req, res) => {
    try {
      const logToDelete = await AccessLog.findById(req.params.id);
      
      if (!logToDelete) {
        return res.status(404).json({ error: 'Log not found' });
      }

      if (logToDelete.access === true) {
        if (logToDelete.isEntry === true) {
          counterCurrentUsersNow = Math.max(0, counterCurrentUsersNow - 1);
          console.log(`[API] Удален лог входа. Счетчик уменьшен: ${counterCurrentUsersNow}`);
        } else {
          counterCurrentUsersNow += 1;
          console.log(`[API] Удален лог выхода. Счетчик увеличен: ${counterCurrentUsersNow}`);
        }
      }

      await AccessLog.findByIdAndDelete(req.params.id);

      res.json({ 
        success: true, 
        message: 'Log deleted successfully', 
        currentCounterInUsers: counterCurrentUsersNow 
      });

    } catch (err) {
      console.error("Delete log error:", err);
      res.status(500).json({ error: 'Delete log error' });
    }
  });

  // get users work hours, PROBLEM WITH POST IT TO FRONTEND
  app.get('/api/users/work-time', async (req, res) => {
    try {
      const users = await User.find().lean();
      const workTimeReport = users.map(user => {
        const totalMs = user.totalWorkMs || 0;
        return {
          _id: user._id,
          user_id: user.user_id,
          name: user.name,
          created_at: user.created_at,
          totalWorkHours: Math.round(totalMs / 1000) 
        };
      });
      res.json(workTimeReport);
    } catch (err) {
      res.status(500).json({ error: 'Calculate work time error' });
    }
  });

  // Reset users work hours 
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

    // deleting all logs(but not database with users id!!!), end work day
  app.delete('/api/data-all', async (req, res) => {
    try {
      state.counterCurrentUsersNow = 0;
      await AccessLog.deleteMany({});
      res.json({ message: 'Day finished, counters reset' });
    } catch (err) {
      console.error("Day finish error:", err);
      res.status(500).json({ error: 'Day finish error' });
    }
  });

  // users limit 
  app.post('/api/set-users-limit', async (req, res) => {
    try {
      const usersLimitParam = req.body.limitUsers;
      const counterInUsersParam = req.body.counterInUsers;
    
      if (usersLimitParam !== undefined && usersLimitParam !== null) {
        state.usersLimit = parseInt(usersLimitParam, 10) || 0;
        state.isLimitWorking = state.usersLimit !== 0;
      }
      
      if (counterInUsersParam !== undefined && counterInUsersParam !== null) {
        state.counterCurrentUsersNow = parseInt(counterInUsersParam, 10) || 0;
      }

      console.log(`[API] Обновлены лимиты. Максимум: ${state.usersLimit}, Сейчас внутри: ${state.counterCurrentUsersNow}`);

      res.status(200).json({ 
        currentLimit: state.usersLimit, 
        currentCounterInUsers: state.counterCurrentUsersNow,
        isLimitWorking: state.isLimitWorking
      });
    } catch (err) {
      console.error("Error in set-users-limit route:", err);
      res.status(500).json({ error: 'set users limit error' });
    }
  });

  //connection with modules for react
  app.get('/api/connection-to-server', async (req, res) => {
    try {
      const now = Date.now();

      if (!state.currentTimeCard || now - state.currentTimeCard > 20000) {
        state.StatusCardModuleConnection = false; 
      }

      if (!state.currentTimeLock || now - state.currentTimeLock > 20000) {
        state.StatusMainLockModuleConnection = false;
      }

      res.json({ 
        connected: state.StatusCardModuleConnection, 
        connectedLock: state.StatusMainLockModuleConnection 
      });
    } catch (err) {
      console.error("Error in connection-to-server route:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get('/api/adding-card', (req, res) => res.send(state.isAddingCardBool));
  app.get('/api/hardware-status', (req, res) => res.send(state.isEmergencyBool));

  // HTTP server running
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`СКУД Бэкенд успешно запущен на порту: ${PORT}`);
  });
});
