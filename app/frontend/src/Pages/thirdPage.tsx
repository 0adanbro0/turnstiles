import { ThirdPageProps } from "../Interfaces"

const ThirdPage = ({counterIn, counterOut}: ThirdPageProps)=>{
    return(
        <>
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