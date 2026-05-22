import { useEffect, useState, useMemo, useCallback, ChangeEvent} from 'react';
import './App.css'
import { BrowserRouter, Routes, Route, Link} from 'react-router-dom';
import { EntryLogs, AddNewUser} from './Interfaces';

import FirstPage from './Pages/firstPage';
import SecondPage from './Pages/secondPage';
import ThirdPage from './Pages/thirdPage'

function App() {
  const [users, setUsers] = useState<AddNewUser[]>([]);
  const [valueInputAdd, setValueInputAdd] = useState<string>(''); 
  const [valueInputSearchLogs, setValueInputSearchLogs] = useState<string>(''); 
  const [logs, setLogs] = useState<EntryLogs[]>([]);
  const [currentLimit, setCurrentLimit] = useState<number>(0);
  const [valueInputSearchUsers, setValueInputSearchUsers] = useState<string>(''); 
  const [isEmergency, setIsEmergency] = useState<boolean>(false)

  const API_URL = import.meta.env.VITE_API_URL;

  const { counterIn, counterOut } = useMemo(() => {
    let countIn: number = 0;
    let countOut: number = 0;

    logs.forEach((elem) => {
      if (elem.isEntry && elem.access) countIn += 1;
      else if(!elem.isEntry && elem.access) countOut += 1;
    });

    return { counterIn: countIn, counterOut: countOut };
  }, [logs]);

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

  useEffect(() => {
    if (logs.length === 0) return;

    fetch(`${API_URL}/api/set-users-limit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ 
        limitUsers: currentLimit 
      })
    })
    .catch(err => console.error("Ошибка синхронизации лимита:", err));
  }, [logs.length, currentLimit, API_URL]);

  useEffect(()=>{
    fetch(`${API_URL}/api/emergency-situation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
    body: JSON.stringify({ 
        isEmergency:  isEmergency
      })
    })
  }, [API_URL, isEmergency])

  const setLimitUsers = (param:number) => setCurrentLimit(param);

  const setIsEmergencyFunc = (arg:boolean) => setIsEmergency(arg);

  const addUsersInput = (event: ChangeEvent<HTMLInputElement>) => setValueInputAdd(event.target.value);

  const searchLogs = (event: ChangeEvent<HTMLInputElement>) => setValueInputSearchLogs(event.target.value);

  const searchUsers = (event: ChangeEvent<HTMLInputElement>) => setValueInputSearchUsers(event.target.value);

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

  const totalWorkHours = useCallback(() => {
    fetch(`${API_URL}/api/users/work-time`)
      .then(res => res.json())
      .then(json => setUsers(json))
      .catch(err => console.error("Ошибка обновления занятости", err));
  }, [API_URL]);

  // Polling: update data every 3 seconds
  useEffect(() => {
    const logsInterval = setInterval(() => {
      getLogs();
    }, 3000);

    const hoursInterval = setInterval(() => {
      totalWorkHours();
    }, 60000);

    return () => {
      clearInterval(logsInterval);
      clearInterval(hoursInterval);
    };
  }, []);


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
            <Link className='navButton' to="/counter">Отслеживание входа-выхода</Link>
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
          searchUsers={searchUsers}
          valueInputSearchUsers={valueInputSearchUsers}
        />} />
        <Route path="/controlling" element={<SecondPage
          users={users}
          valueInputSearch={valueInputSearchLogs}
          searchUsers={searchLogs}
          logs={logs}
          endWorkDay={endWorkDay}
          addUser={addUserSearch}
        />} />
        <Route path="/counter" element={<ThirdPage
          counterIn={counterIn}
          counterOut={counterOut}
          setLimitUsers={setLimitUsers}
          currentLimit={currentLimit}
          currentUsersIn={counterIn}
          currentUsersOut={counterOut}

          setIsEmergencyFunc={setIsEmergencyFunc}
          isEmergency={isEmergency}
        />}/>
      </Routes>
    </BrowserRouter>
  );
}

export default App;
