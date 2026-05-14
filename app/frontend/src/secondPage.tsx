import { SecondPageProps } from "./interfaces";

const SecondPage = ({ logs, valueInputSearch = '', searchUsers }: SecondPageProps) => {
  
  const filteredLogs = logs.filter((log) => {
    if (!log.user_id) return false;
    return log.user_id.toLowerCase().includes(valueInputSearch.toLowerCase());
  });

  return (
    <div className="SecondPage">
      <div className='actionsUsers'>
        <input 
          type="text"
          placeholder="Поиск по ID карты..."
          value={valueInputSearch}
          onChange={searchUsers}
        />
      </div>
      
      <div className='infoUsers'>
        <h2>Время</h2>
        <h2>ID Пользователя</h2>
        <h2>Действие</h2>
      </div>

      {filteredLogs.map((log) => (
        <div className='cardUser' key={log._id}>
          <h2>{new Date(log.timestamp).toLocaleString()}</h2>
          <h2><b style={{ color: '#007bff' }}>{log.user_id}</b></h2>
          <h2>{log.isEntry ? '🟢 Вход (in)' : '🔴 Выход (out)'}</h2>
        </div>
      ))}

      {filteredLogs.length === 0 && (
        <div style={{ textAlign: 'center', marginTop: '20px', color: '#888' }}>
          Записей не найдено
        </div>
      )}
    </div>
  );
};

export default SecondPage;
