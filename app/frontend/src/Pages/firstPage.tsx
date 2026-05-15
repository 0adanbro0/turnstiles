import { FirstPageProps} from './../Interfaces';

const FirstPage = ({ users, valueInput, addUsersInput, addUser, deleteUser}: FirstPageProps) => 
  <div className="firstPage">

    <div className='actionsUsers'>
      <button onClick={()=>addUser()}>Добавить пользователя</button>
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
        <div>
          {users.length === 0 ? <p>База данных пуста</p> 
            : users.map((log) => (
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
    </div>
  </div>;

export default FirstPage