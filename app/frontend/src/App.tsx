import { useEffect, useState, useCallback, ChangeEvent} from 'react';
import './app.css'
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';

// описывание перемнных из бд
interface AccessLog {
  _id: string;
  user_id: string
  timestamp: string;
}

interface FirstPageProps {
  logs: AccessLog[];
  valueInput: string | undefined;
  handleChange: (event: ChangeEvent<HTMLInputElement>) => void;
  addUser: () => void;
  deleteUser: (id:string) => void;
}

const FirstPage = ({ logs, valueInput, addUsersInput, addUser, deleteUser}: FirstPageProps) => 
  <div className="firstPage">

    <div className='actionsUsers'>
      <button onClick={addUser}>Добавить пользователя</button>
      <input type="text"
        value={valueInput}
          onChange={addUsersInput}
        />
    </div>
    <div className='infoUsers'>
      <h2>ID Пользователя</h2>
      <h2>Действие</h2>
    </div>
    <div className='boxUsers'>
      <div className='displayUsers'>
        {logs.length === 0 ? <p>База данных пуста</p> 
          : logs.map((log) => (
            <div className='cardUser' key={log._id}>
              <h2><b style={{ color: '#007bff' }}>{log.user_id}</b></h2>
              <button onClick={() => deleteUser(log._id)}>
                удалить пользователя
              </button>
            </div>
          ))
        }
      </div>
    </div>
  </div>;
  const SecondPage = ({ logs, valueInput, searchUSers, deleteUser}: FirstPageProps) => 
  <div className="SecondPage">
    {logs.length === 0 ? <p>База данных пуста</p> 
      : logs.map((log) => (
        <div className='cardUser' key={log._id}>
          <h2>{new Date(log.timestamp).toLocaleString()}</h2>
          <h2><b style={{ color: '#007bff' }}>{log.user_id}</b></h2>
          <button onClick={() => deleteUser(log._id)}>
            удалить пользователя
          </button>
        </div>
      ))
    }
  </div>;

function App() {
  const [logs, setLogs] = useState<AccessLog[]>([]);
  const [valueInput, setValueInput] = useState<string>()
  const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

  const deleteUser = (id: string) => {
    fetch(`${API_URL}/api/data/${id}`, {
      method: 'DELETE',
    })
    .then((res) => {
      if (res.ok) {
        // Обновляем локальный стейт, чтобы убрать удаленного пользователя
        setLogs(prevLogs => prevLogs.filter(log => log._id !== id));
      }
    })
    .catch(err => console.error("Ошибка при удалении:", err));
};

  const getLogs = useCallback(() => {
    fetch(`${API_URL}/api/data`)
      .then(res => res.json())
      .then(json => setLogs(json))
      .catch(err => console.error("Ошибка загрузки:", err));
  }, [API_URL]);

  const addUsersInput = (event:  ChangeEvent<HTMLInputElement>) => {
    setValueInput(event.target.value);
  };

  const addUser = () => {
    const sendId = valueInput
    
    fetch(`${API_URL}/api/data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        user_id: sendId, 
        device_id: "ESP32_Turnstile_1" 
      })
    })
    .then(() => getLogs())
    .catch(err => console.error("Ошибка отправки:", err));
  };

  useEffect(() => { 
    getLogs(); 
  }, [getLogs]);



  return (
    <BrowserRouter>
      <nav>
        <div className="menu">
          <div className='center'>
            <div className="titleBox">
              <h1 className='titleInfo'>Административная панель турникетами</h1>
            </div>
          </div>
          <div className="navBox">
            <Link className='navButton' to="/db">База данных</Link>
            <Link className='navButton' to="/controlling">Отслеживание пользователей</Link>
          </div>
        </div>
      </nav>

      <hr />

      <Routes>
        <Route path="/db" element={<FirstPage 
        logs={logs} 
        valueInput={valueInput} 
        handleChange={addUsersInput} 
        addUser={addUser} 
        deleteUser={deleteUser}
        />} />
        <Route path="/controlling" element={<SecondPage />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;

/*
*/