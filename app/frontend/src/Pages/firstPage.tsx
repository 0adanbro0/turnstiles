import { FirstPageProps} from './../Interfaces';
import Button from '../UI/buttonProps';

const FirstPage = ({ users, valueInput, addUsersInput, addUser, deleteUser}: FirstPageProps) => 
  <div className="firstPage">
    
    <div className='actionsUsers'>
      <Button onclick={()=>addUser()} className='buttonAction' content="добавить пользователя"/>
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
            : users.map((user) => (
              <div className='cardUser' key={user._id}>
                <h2><b style={{ color: '#007bff' }}>{user.user_id}</b></h2>
                <button onClick={() => deleteUser(user._id)}>
                  удалить пользователя
                </button>
                <h2>{user.totalWorkHours ? user.totalWorkHours : 0} секунд</h2>
              </div>
            ))
          }
        </div>
      </div>
    </div>
  </div>;

export default FirstPage