import { useState, ChangeEvent } from 'react';
import { ThirdPageProps } from "../Interfaces"

const ThirdPage = ({counterIn, counterOut, setLimitUsers, isEmergency, setIsEmergencyFunc, currentLimit, currentUsersIn, currentUsersOut}: ThirdPageProps)=>{
    const [inputcontent, setInputContent] = useState('')
    const isEmergencyPage:boolean = isEmergency; 
    
    return(
        <>
            <div className="controlPanelLimit">
                <button className={'buttonAction'} onClick={()=>{setLimitUsers(Number(inputcontent))}}>Установить лимит</button>
                <input type="text" className='inputForButtonAction'
                    value={inputcontent}
                    placeholder='Введите лимит'
                    onChange={(event: ChangeEvent<HTMLInputElement>)=>setInputContent(event.target.value)}
                />
                <button className={'buttonAction'} onClick={()=>setIsEmergencyFunc(!isEmergencyPage ? true : false)}>{isEmergencyPage ? "заблокировать свободный проход" : "разблокировать свободный проход"}</button>

                <h2>limit:{currentUsersIn - currentUsersOut}/{currentLimit}</h2>
            </div>

            <div className="columnCounter">
                <h1>Вход :{counterIn}</h1>
            </div>
            
            <div className="columnCounter">
                <h1>Выход :{counterOut}</h1>
            </div>
        </>
    )
}

export default ThirdPage