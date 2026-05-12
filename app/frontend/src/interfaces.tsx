import { ChangeEvent } from "react";

//добавление пользователя
export interface AddNewUser {
  _id: string;
  user_id: string
}

//отслеживание входов
export interface EntryLogs {
  _id: string;
  user_id: string;
  timestamp: string;
  accessEntry: boolean;
}

//вторая страница 
export interface SecondPageProps {
  logs: AddNewUser[];
  valueInputSearch: string | undefined;
  searchUsers: (event: ChangeEvent<HTMLInputElement>) => void;
  deleteUser: (id:string) => void;
  timestamp: string;
  freshUsers: EntryLogs[];
}

export interface FirstPageProps {
  logs: AddNewUser[];
  valueInput: string | undefined;
  addUsersInput: (event: ChangeEvent<HTMLInputElement>) => void;
  addUser: () => void;
  deleteUser: (id:string) => void;
}