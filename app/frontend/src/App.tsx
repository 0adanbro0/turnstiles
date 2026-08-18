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
  const [buttonAccessLevel, setButtonAccessLevel] = useState<string>('firstLevel')

  const isFirstRenderEmergency = useRef(true);
  const isFirstRenderAdding = useRef(true);

  const API_URL = import.meta.env.VITE_API_URL;
  const API_KEY = import.meta.env.VITE_API_KEY; // ОБЯЗАТЕЛЬНО: добавь VITE_API_KEY в .env фронтенда

  // --- УНИВЕРСАЛЬНАЯ ОБЕРТКА ДЛЯ FETCH (внутри компонента, без новых файлов) ---
  const apiFetch = useCallback(async <T,>(endpoint: string, options: RequestInit = {}): Promise<T> => {
    const headers = new Headers(options.headers);
    headers.set('Content-Type', 'application/json');
    if (API_KEY) headers.set('X-API-Key', API_KEY); // Автоматически подставляем ключ везде

    const res = await fetch(`${API_URL}${endpoint}`, { ...options, headers });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({ error: 'Server error' }));
      throw new Error(errData.error || `HTTP ${res.status}`);
    }
    if (res.status === 204) return undefined as T;
    return res.json();
  }, [API_URL, API_KEY]);

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
    apiFetch<{ data: AddNewUser[]; total: number }>('/api/users') // Тип ответа бэкенда
      .then(json => setUsers(json.data)) // <--- БЕРЕМ .data
      .catch(err => console.error("Ошибка загрузки пользователей:", err));
  }, [apiFetch]);

  const getLogs = useCallback(() => {
    apiFetch<{ data: EntryLogs[]; total: number }>('/api/data') // Тип ответа бэкенда
      .then(json => setLogs(json.data)) // <--- БЕРЕМ .data
      .catch(err => console.error("Ошибка загрузки истории:", err));
  }, [apiFetch]);

  // totalWorkHours тоже возвращает массив отчетов, не пользователей, оставляем как есть (console.log)
  const totalWorkHours = useCallback(() => {
    apiFetch<any[]>('/api/users/work-time')
      .then(json => console.log('[WorkTime Report]', json))
      .catch(err => console.error("Ошибка отчета по часам:", err));
  }, [apiFetch]);

  const deleteUser = (id: string) => {
    apiFetch(`/api/users/${id}`, { method: 'DELETE' })
      .then(() => setUsers(prevUsers => prevUsers.filter(user => user._id !== id)))
      .catch(err => console.error("Ошибка при удалении пользователя:", err));
  };

  const endWorkDay = () => {
    apiFetch('/api/data-all', { method: 'DELETE' })
      .then(() => setLogs([]))
      .catch(err => console.error("Ошибка при очистке логов:", err));
  };

  // 1. LIMIT SYNC: Payload исправлен на { usersLimitParam: number }
  useEffect(() => {
    apiFetch('/api/set-users-limit', {
      method: 'POST',
      body: JSON.stringify({ usersLimitParam: currentLimit })
    })
    .catch(err => console.error("Ошибка синхронизации лимита:", err));
  }, [currentLimit, apiFetch]);

  // 2. EMERGENCY MODE: Payload исправлен на { value: boolean }
  useEffect(() => {
    if (isFirstRenderEmergency.current) {
      isFirstRenderEmergency.current = false;
      return;
    }
    apiFetch('/api/emergency-situation', {
      method: 'POST',
      body: JSON.stringify({ value: isEmergency })
    })
    .catch(err => console.error("Ошибка изменения статуса ЧС:", err));
  }, [isEmergency, apiFetch]);

  // 3. ADDING CARD MODE: Payload исправлен на { value: boolean }
  useEffect(() => {
    if (isFirstRenderAdding.current) {
      isFirstRenderAdding.current = false;
      return;
    }
    apiFetch('/api/adding-card', {
      method: 'POST',
      body: JSON.stringify({ value: isAddingCard })
    })
    .catch(err => console.error("Ошибка изменения режима добавления карт:", err));
  }, [isAddingCard, apiFetch]);

  const getDevicesStatus = useCallback(() => {
    apiFetch<ConnectionResponse>('/api/connection-to-server')
      .then((data) => {
        setCardModuleStatus(Boolean(data?.connected));
        setStatusMainLockModule(Boolean(data?.connectedLock));
      })
      .catch((err) => {
        console.error("Ошибка запроса статуса ESP32:", err);
        setCardModuleStatus(false);
        setStatusMainLockModule(false);
      });
  }, [apiFetch]);

  // Control handlers (передаются в дочерние компоненты без изменений)
  const setIsAddingCardFunc = (arg: boolean) => setIsAddingCard(arg);
  const setLimitUsers = (param: number) => setCurrentLimit(param);
  const setIsEmergencyFunc = (arg: boolean) => setIsEmergency(arg);
  const addUsersInput = (event: ChangeEvent<HTMLInputElement>) => setValueInputAdd(event.target.value);
  const addInfoAccessLevel = (param: string) => setButtonAccessLevel(param)
  const searchLogs = (event: ChangeEvent<HTMLInputElement>) => setValueInputSearchLogs(event.target.value);
  const searchUsers = (event: ChangeEvent<HTMLInputElement>) => setValueInputSearchUsers(event.target.value);

  const addUser = () => {
    const idToSend:string = valueInputAdd.trim();
    const accessLevelToSend:string = buttonAccessLevel.trim()
    if (!idToSend || !accessLevelToSend) return;

    // Backend ожидает user_id, name?, accessLevel? ... strict schema.
    // Добавляем name: '' чтобы не падать на strict валидации, если бэкенд ждет name.
    apiFetch<AddNewUser>('/api/users', {
      method: 'POST',
      body: JSON.stringify({ user_id: idToSend, accessLevel: accessLevelToSend, name: '' })
    })
    .then(() => {
      getUsers();
      setValueInputAdd('');
    })
    .catch(err => console.error("Ошибка добавления пользователя:", err));
  };

  const addUserSearch = (id: string) => {
    if (!id) return;
    apiFetch<AddNewUser>('/api/users', {
      method: 'POST',
      body: JSON.stringify({ user_id: id, name: '', accessLevel: buttonAccessLevel })
    })
    .then(() => getUsers())
    .catch(err => console.error("Ошибка при быстром добавлении пользователя:", err));
  };

  // Initial data load
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

  // Data polling
  useEffect(() => {
    const logsInterval = setInterval(() => { getLogs(); }, 3000);
    const hoursInterval = setInterval(() => { totalWorkHours(); }, 60000);
    const usersRerender = setInterval(() => { getUsers(); }, 3000);

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
            addInfoAccessLevel={addInfoAccessLevel}
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