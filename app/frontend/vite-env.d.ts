/// <reference types="vite/client" />

// Разрешает импорт *.css, *.scss как модули или side-effect
declare module '*.css' {
  const content: string;
  export default content;
}