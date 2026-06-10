import { FirstPageProps} from './../Interfaces';
import Button from '../UI/buttonProps';

const FirstPage = ({ users, addInfoAccessLevel, valueInput, addUsersInput, addUser, deleteUser, searchUsers, valueInputSearchUsers}: FirstPageProps) => 
{
  const filteredUsers = users.filter((user) => {
    if (!user.user_id) return false;
    return user.user_id.toLowerCase().includes(valueInputSearchUsers.toLowerCase());
  });


  return(
    <>
      <div className="firstPage">
        
        <div className='actionUsers'>
          <Button onclick={()=>addInfoAccessLevel('firstLevel')} className='buttonAction' content='первый уровень доступа'/>
          <Button onclick={()=>addInfoAccessLevel('secondLevel')} className='buttonAction' content='второй уровень доступа'/>
          <Button onclick={()=>addInfoAccessLevel('thirdLevel')} className='buttonAction' content='третий уровень доступа'/>

          <Button onclick={()=>addUser()} className='buttonAction' content="добавить пользователя"/>
          <input type="text" className='inputForButtonAction'
            value={valueInput}
            onChange={addUsersInput}
            placeholder='Введите id'
          />
          <input 
            className="inputForButtonAction"
            type="text"
            placeholder="Поиск по ID карты..."
            value={valueInputSearchUsers}
            onChange={searchUsers}
          />
        </div>
        <div className='infoUsers'>
          <h2>ID Пользователя</h2>
          <h2>Уровень доступа</h2>
          <h2>Действие</h2>
          <h2>Отработка</h2>
        </div>
        <div className='boxUsers'>
          <div className='displayUsers'>
            <div className='columnBlock'>
              {filteredUsers.length === 0 ? <p className='notFound'>База данных пуста</p> 
                : filteredUsers.map((user) => (
                  <div className='cardUser' key={user._id}>
                    <h2><b style={{ color: '#007bff' }}>{user.user_id}</b></h2>
                    <h2><b style={user.accessLevel === "thirdLevel" ? {color: '#c5a059'} : {color: '#1e40af'}}>{user.accessLevel}</b></h2>
                    <Button className={'buttonAction'} onclick={() => deleteUser(user._id)} content={'удалить пользователя'}/>
                    <h2>{user.totalWorkHours ? user.totalWorkHours : 0} секунд</h2>
                  </div>
                ))
              }
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

export default FirstPage