import { useEffect, useState, useCallback, ChangeEvent} from 'react';
import './app.css'
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import { EntryLogs, AddNewUser } from './interfaces';

import FirstPage from './firstPage';
import SecondPage from './secondPage';

function App() {
  const [logs, setLogs] = useState<AddNewUser[]>([]);
  const [valueInputAdd, setValueInputAdd] = useState<string>()
  const [valueInputSearch, setValueInputSearch] = useState<string>()
  const [freshUsers, setFreshUsers] = useState<EntryLogs[]>([])

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
    setValueInputAdd(event.target.value);
  };

  const searchUsers = (event:  ChangeEvent<HTMLInputElement>) => {
    setValueInputSearch(event.target.value);
  };

  const addUser = () => {
    const sendId = valueInputAdd
    
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
        valueInput={valueInputAdd} 
        addUsersInput={addUsersInput} 
        addUser={addUser} 
        deleteUser={deleteUser}
        />} />
        <Route path="/controlling" element={<SecondPage
          logs={logs}
          valueInputSearch={valueInputSearch}
          searchUsers={searchUsers}
          deleteUser={deleteUser}
          freshUsers={freshUsers}
          timestamp=''
        />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;

/*
*/