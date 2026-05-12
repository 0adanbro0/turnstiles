import { SecondPageProps } from "./interfaces";

  const SecondPage = ({freshUsers, valueInputSearch, searchUsers, deleteUser}: SecondPageProps) => 
  <div className="SecondPage">
    <div className='actionsUsers'>
      <input type="text"
        value={valueInputSearch}
        onChange={searchUsers}
      />
    </div>
    <div className='infoUsers'>
      <h2>ID Пользователя</h2>
      <h2>Действие</h2>
    </div>

    {valueInputSearch === '' ? <p>Проходов не зафиксировано</p> 
      : freshUsers.filter((item) =>
        item._id.includes(valueInputSearch!)
      ).map((log) => (
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

export default SecondPage