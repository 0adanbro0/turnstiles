import { useState, ChangeEvent } from 'react';
import { ThirdPageProps } from "../Interfaces"

const ThirdPage = ({counterIn, counterOut, setLimitUsers, currentLimit, currentUsersIn, currentUsersOut}: ThirdPageProps)=>{
    const [inputcontent, setInputContent] = useState('')
    
    return(
        <>
            <div className="controlPanelLimit">
                <button className={'buttonAction'} onClick={()=>{setLimitUsers(Number(inputcontent))}}>Установить лимит</button>
                <input type="text"
                    value={inputcontent}
                    onChange={(event: ChangeEvent<HTMLInputElement>)=>setInputContent(event.target.value)}
                />

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