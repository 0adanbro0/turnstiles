import { SecondPageProps } from "../Interfaces";
import Button from "../UI/buttonProps";

const SecondPage = ({endWorkDay, logs, valueInputSearch = '', searchUsers, addUser, users}: SecondPageProps) => {
  
  const filteredLogs = logs.filter((log) => {
    if (!log.user_id) return false;
    return log.user_id.toLowerCase().includes(valueInputSearch.toLowerCase());
  });

  return (
    <div className="SecondPage">
      <div className='actionsUsers'>
        <Button onclick={endWorkDay} className="buttonAction" content="Закончить рабочий день"/>
        <input 
          className="inputForButtonAction"
          type="text"
          placeholder="Поиск по ID карты..."
          value={valueInputSearch}
          onChange={searchUsers}
        />
      </div>
      
      <div className='infoUsers'>
        <h2>Время</h2>
        <h2>ID Пользователя</h2>
        <h2>Состояние</h2>
        <h2>Действие</h2>
        <h2>Разрешение</h2>
      </div>

      <div className="boxLogs">
        <div className="displayLogs">
          <div className="columnBlock">
            {filteredLogs.map((log) => (
              <div className='cardUser' key={log._id}>
                <h2>{new Date(log.timestamp).toLocaleString()}</h2>
                <h2><b style={{ color: '#007bff' }}>{log.user_id}</b></h2>
                <h2>{log.isEntry ? '🟢Вход' : '🔴Выход'}</h2>
                <Button className={'buttonAction'} content={users.some(user => user.user_id === log.user_id) ? 'пользователь добавлен' : 'добавить пользователя'} onclick={()=>addUser(log.user_id)}/>
                <h2>{log.access == false ? 'запрещен' : 'разрешен'}</h2>
              </div>
            ))}

            {filteredLogs.length === 0 && (
              <p className="notFound">
                Записей не найдено
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SecondPage;
