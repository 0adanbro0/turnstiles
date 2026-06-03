const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  user_id: { type: String, required: true, unique: true },
  name: { type: String, default: 'User' },
  created_at: { type: Date, default: Date.now },
  totalWorkMs: { type: Number, default: 0 } 
}, { versionKey: false });

const LogSchema = new mongoose.Schema({
  user_id: { type: String, required: true },
  isEntry: { type: Boolean, default: true },
  timestamp: { type: Date, default: Date.now },
  access: { type: Boolean, default: false },
}, { versionKey: false });

const User = mongoose.model('User', UserSchema);
const AccessLog = mongoose.model('AccessLog', LogSchema);

function connectToMongoDB(mongoUri) {
  return mongoose.connect(mongoUri)
    .then(() => {
      console.log('Connected to MongoDB');
      AccessLog.schema.index({ user_id: 1, access: 1, timestamp: -1 });
      User.schema.index({ user_id: 1 });
    })
    .catch(err => {
      console.error('MongoDB connection error:', err);
      process.exit(1);
    });
}

module.exports = { User, AccessLog, connectToMongoDB };
