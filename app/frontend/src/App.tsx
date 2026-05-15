import { useEffect, useState, useCallback, ChangeEvent} from 'react';
import './App.css'
import { BrowserRouter, Routes, Route, Link} from 'react-router-dom';
import { EntryLogs, AddNewUser } from './Interfaces';

import FirstPage from './Pages/firstPage';
import SecondPage from './Pages/secondPage';

function App() {
const [users, setUsers] = useState<AddNewUser[]>([]);
const [valueInputAdd, setValueInputAdd] = useState<string>(''); 
const [valueInputSearch, setValueInputSearch] = useState<string>(''); 
const [logs, setLogs] = useState<EntryLogs[]>([]);

const API_URL = import.meta.env.VITE_API_URL;

  const getUsers = useCallback(() => {
    fetch(`${API_URL}/api/users`)
      .then(res => res.json())
      .then(json => setUsers(json))
      .catch(err => console.error("Ошибка загрузки пользователей:", err));
  }, [API_URL]);

  const getLogs = useCallback(() => {
    fetch(`${API_URL}/api/data`)
      .then(res => res.json())
      .then(json => setLogs(json))
      .catch(err => console.error("Ошибка загрузки истории:", err));
  }, [API_URL]);

  const deleteUser = (id: string) => {
    fetch(`${API_URL}/api/users/${id}`, {
      method: 'DELETE',
    })
    .then((res) => {
      if (res.ok) {
        setUsers(prevUsers => prevUsers.filter(user => user._id !== id));
      }
    })
    .catch(err => console.error("Ошибка при удалении пользователя:", err));
  };

  const endWorkDay = () => {
    fetch(`${API_URL}/api/data-all`, {
      method: 'DELETE',
    })
    .then((res) => {
      if (res.ok) {
        setLogs([])
      }
    })
    .catch(err => console.error("Ошибка при удалении пользователя:", err));
  };

  const addUsersInput = (event: ChangeEvent<HTMLInputElement>) => {
    setValueInputAdd(event.target.value);
  };

  const searchUsers = (event: ChangeEvent<HTMLInputElement>) => {
    setValueInputSearch(event.target.value);
  };

  const addUser = () => {
    const idToSend = valueInputAdd.trim();

    if (!idToSend) return;

    fetch(`${API_URL}/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        user_id: String(idToSend)
      })
    })
    .then((res) => {
      if (res.ok) {
        getUsers();
        setValueInputAdd('');
      }
    })
    .catch(err => console.error("Ошибка:", err));
  };

  const addUserSearch = (id:string) => {
    const idToSend = id;

    if (!idToSend) return;

    fetch(`${API_URL}/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        user_id: String(idToSend)
      })
    })
    .then((res) => {
      if (res.ok) {
        getUsers();
        setValueInputAdd('');
      }
    })
    .catch(err => console.error("Ошибка:", err));
  };

  useEffect(() => { 
    getLogs();
    getUsers(); 
  }, [getUsers, getLogs]);

  // Polling: update data every 3 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      getLogs();
    }, 3000);

    return () => clearInterval(interval);
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
          users={users} 
          valueInput={valueInputAdd} 
          addUsersInput={addUsersInput} 
          addUser={addUser} 
          deleteUser={deleteUser}
        />} />
        <Route path="/controlling" element={<SecondPage
          users={users}
          valueInputSearch={valueInputSearch}
          searchUsers={searchUsers}
          logs={logs}
          endWorkDay={endWorkDay}
          addUser={addUserSearch}
        />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
