import { useState, ChangeEvent } from 'react';
import { ThirdPageProps } from "../Interfaces"
import Button from '../UI/buttonProps';

const ThirdPage = ({counterIn, counterOut, setLimitUsers, isEmergency, statusMainLockModule, statusCardModule, isAddingCard, setIsAddingCardFunc, setIsEmergencyFunc, currentLimit, currentUsersIn, currentUsersOut}: ThirdPageProps)=>{
    const [inputcontent, setInputContent] = useState('')
    const isEmergencyPage:boolean = isEmergency; 
    const isAddingCardPage:boolean = isAddingCard;
    
    return(
        <div>
            <div className="controlPanelLimit">
                <button className={'buttonAction'} onClick={()=>{setLimitUsers(Number(inputcontent))}}>Установить лимит</button>
                <input type="text" className='inputForButtonAction'
                    value={inputcontent}
                    placeholder='Введите лимит'
                    onChange={(event: ChangeEvent<HTMLInputElement>)=>setInputContent(event.target.value)}
                />
                <Button className={'buttonAction'} onclick={()=>setIsEmergencyFunc(!isEmergencyPage ? true : false)} content={isEmergencyPage ? "свободный проход" : "закрытый проход"}/>
                <Button className={'buttonAction'} onclick={()=>setIsAddingCardFunc(!isAddingCardPage ? true : false)} content={isAddingCardPage ? "активно" : "неактивно"}/>
            </div>

            <div className='boxConnection'>
                <div>
                    <div className='cardConnection'>
                    <h2 className='connectionModule'>подключение модуля RFID-карт : </h2>
                    <h2 className='connectionInfo'>{!statusCardModule? "lost" : "okey"}</h2>
                </div>

                <div className='cardConnection'>
                    <h2 className='connectionModule'>подключение модуля замка : </h2>
                    <h2 className='connectionInfo'>{!statusMainLockModule? "lost" : "okey"}</h2>
                </div>

                <div className='cardConnection'>
                    <h2 className='connectionModule'>подключение модля отпечатка пальцев : </h2>
                    <h2 className='connectionInfo'>{!statusCardModule? "lost" : "okey"}</h2>
                </div>
                </div>
            </div>

            <h2>лимит : {currentUsersIn - currentUsersOut}/{currentLimit}</h2>

            <div className="columnCounter">
                <h1>Вход : {counterIn}</h1>
            </div>
            
            <div className="columnCounter">
                <h1>Выход : {counterOut}</h1>
            </div>
        </div>
    )
}

export default ThirdPage