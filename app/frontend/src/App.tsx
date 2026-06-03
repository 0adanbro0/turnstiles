import { useEffect, useState, useMemo, useCallback, ChangeEvent, useRef } from 'react';
import './App.css';
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import { EntryLogs, AddNewUser, ConnectionResponse } from './Interfaces';

import FirstPage from './Pages/firstPage';
import SecondPage from './Pages/secondPage';
import ThirdPage from './Pages/thirdPage';

function App() {
  const [users, setUsers] = useState<AddNewUser[]>([]);
  const [valueInputAdd, setValueInputAdd] = useState<string>(''); 
  const [valueInputSearchLogs, setValueInputSearchLogs] = useState<string>(''); 
  const [logs, setLogs] = useState<EntryLogs[]>([]);
  const [currentLimit, setCurrentLimit] = useState<number>(0);
  const [valueInputSearchUsers, setValueInputSearchUsers] = useState<string>(''); 
  const [isEmergency, setIsEmergency] = useState<boolean>(false);
  const [cardModuleStatus, setCardModuleStatus] = useState<boolean>(false);
  const [isAddingCard, setIsAddingCard] = useState<boolean>(false);
  const [statusMainLockModule, setStatusMainLockModule] = useState<boolean>(false)

  // Use refs to stop sending requests on the first render (component mount)
  const isFirstRenderEmergency = useRef(true);
  const isFirstRenderAdding = useRef(true);

  const API_URL = import.meta.env.VITE_API_URL;

  // Calculate entered and exited users
  const { counterIn, counterOut } = useMemo(() => {
    let countIn = 0;
    let countOut = 0;
    logs.forEach((elem) => {
      if (elem.access) {
        if (elem.isEntry) countIn += 1;
        else countOut += 1;
      }
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

  const totalWorkHours = useCallback(() => {
    fetch(`${API_URL}/api/users/work-time`)
      .then(res => res.json())
      .then(json => setUsers(json))
      .catch(err => console.error("Ошибка обновления занятости", err));
  }, [API_URL]);

  const deleteUser = (id: string) => {
    fetch(`${API_URL}/api/users/${id}`, { method: 'DELETE' })
      .then((res) => {
        if (res.ok) setUsers(prevUsers => prevUsers.filter(user => user._id !== id));
      })
      .catch(err => console.error("Ошибка при удалении пользователя:", err));
  };

  const endWorkDay = () => {
    fetch(`${API_URL}/api/data-all`, { method: 'DELETE' })
      .then((res) => {
        if (res.ok) setLogs([]);
      })
      .catch(err => console.error("Ошибка при очистке логов:", err));
  };

  // 1. LIMIT SYNC: Send request only when the number limit changes
  useEffect(() => {
    fetch(`${API_URL}/api/set-users-limit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limitUsers: currentLimit })
    })
    .catch(err => console.error("Ошибка синхронизации лимита:", err));
  }, [currentLimit, API_URL]);

  // 2. EMERGENCY MODE: Skip the first render
  useEffect(() => {
    if (isFirstRenderEmergency.current) {
      isFirstRenderEmergency.current = false;
      return;
    }
    fetch(`${API_URL}/api/emergency-situation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isEmergency })
    })
    .catch(err => console.error("Ошибка изменения статуса ЧС:", err));
  }, [isEmergency, API_URL]);

  useEffect(() => {
    if (isFirstRenderAdding.current) {
      isFirstRenderAdding.current = false;
      return;
    }
    fetch(`${API_URL}/api/adding-card`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isAddingCard })
    })
    .catch(err => console.error("Ошибка изменения режима добавления карт:", err));
  }, [isAddingCard, API_URL]);

  const getDevicesStatus = useCallback(() => {
    fetch(`${API_URL}/api/connection-to-server`)
      .then(res => {
        if (!res.ok) throw new Error('Ошибка сервера');
        return res.json() as Promise<ConnectionResponse>; // Приводим к нужному типу
      })
      .then((data: ConnectionResponse) => {
        // ИСПРАВЛЕНО: Достаем флаг прямо из объекта data.connected
        setCardModuleStatus(Boolean(data && data.connected));
        setStatusMainLockModule(Boolean(data && data.connectedLock));
      })
      .catch((err: unknown) => {
        console.error("Ошибка запроса статуса ESP32:", err);
        setCardModuleStatus(false);
        setStatusMainLockModule(false);
      });
  }, [API_URL]);

  // Control handlers
  const setIsAddingCardFunc = (arg: boolean) => setIsAddingCard(arg);
  const setLimitUsers = (param: number) => setCurrentLimit(param);
  const setIsEmergencyFunc = (arg: boolean) => setIsEmergency(arg);
  const addUsersInput = (event: ChangeEvent<HTMLInputElement>) => setValueInputAdd(event.target.value);
  const searchLogs = (event: ChangeEvent<HTMLInputElement>) => setValueInputSearchLogs(event.target.value);
  const searchUsers = (event: ChangeEvent<HTMLInputElement>) => setValueInputSearchUsers(event.target.value);

  const addUser = () => {
    const idToSend = valueInputAdd.trim();
    if (!idToSend) return;

    fetch(`${API_URL}/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: String(idToSend) })
    })
    .then((res) => {
      if (res.ok) {
        getUsers();
        setValueInputAdd('');
      }
    })
    .catch(err => console.error("Ошибка добавления пользователя:", err));
  };

  const addUserSearch = (id: string) => {
    if (!id) return;
    fetch(`${API_URL}/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: String(id) })
    })
    .then((res) => {
      if (res.ok) getUsers();
    })
    .catch(err => console.error("Ошибка при быстром добавлении пользователя:", err));
  };

  // Get initial data when the app starts
  useEffect(() => { 
    getLogs();
    getUsers();
  }, [getUsers, getLogs]);

  // ESP32 status interval
  useEffect(() => {
    getDevicesStatus();
    const interval = setInterval(getDevicesStatus, 5000);
    return () => clearInterval(interval);
  }, [getDevicesStatus]);

  // Data polling (Update arrays of dependencies for actual closures)
  useEffect(() => {
    const logsInterval = setInterval(() => {
      getLogs();
    }, 3000);

    const hoursInterval = setInterval(() => {
      totalWorkHours();
    }, 60000);

    const usersRerender = setInterval(() => {
      getUsers();
    }, 3000);

    return () => {
      clearInterval(usersRerender);
      clearInterval(hoursInterval);
      clearInterval(logsInterval);
    };
  }, [getLogs, totalWorkHours, getUsers]);

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
            <Link className='navButton' to="/counter">Настройки</Link>
          </div>
        </div>
      </nav>

      <hr />

      <Routes>
        <Route path="/db" element={
          <FirstPage 
            users={users} 
            valueInput={valueInputAdd} 
            addUsersInput={addUsersInput} 
            addUser={addUser} 
            deleteUser={deleteUser}
            searchUsers={searchUsers}
            valueInputSearchUsers={valueInputSearchUsers}
          />
        } />
        <Route path="/controlling" element={
          <SecondPage
            users={users}
            valueInputSearch={valueInputSearchLogs}
            searchUsers={searchLogs}
            logs={logs}
            endWorkDay={endWorkDay}
            addUser={addUserSearch}
          />
        } />
        <Route path="/counter" element={
          <ThirdPage
            counterIn={counterIn}
            counterOut={counterOut}
            setLimitUsers={setLimitUsers}
            currentLimit={currentLimit}
            currentUsersIn={counterIn}
            currentUsersOut={counterOut}
            setIsEmergencyFunc={setIsEmergencyFunc}
            isEmergency={isEmergency}
            setIsAddingCardFunc={setIsAddingCardFunc}
            isAddingCard={isAddingCard}
            statusCardModule={cardModuleStatus}
            statusMainLockModule={statusMainLockModule}
          />
        } />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
