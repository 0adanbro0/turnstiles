interface ButtonProps{
    onclick: ()=>void;
    className: string;
    content: string;
}

const Button = ({onclick, className, content}: ButtonProps)=>{
    return(
        <>
            <button onClick={onclick} className={className}>{content}</button>
        </>
    )
}

export default Button;