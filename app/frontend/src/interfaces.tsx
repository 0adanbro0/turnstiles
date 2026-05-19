import { ChangeEvent } from "react";

export interface AddNewUser {
  _id: string;
  user_id: string;
  totalWorkHours: number;
}

export interface EntryLogs {
  _id: string;
  user_id: string;
  timestamp: string;
  isEntry: boolean;
  access:boolean;
}

export interface ThirdPageProps {
  counterIn:number;
  counterOut:number;
  setLimitUsers: (arg1:number)=>void;
  currentLimit: number;
  currentUsersIn:number;
  currentUsersOut:number;
}

export interface SecondPageProps {
  users: AddNewUser[];
  valueInputSearch: string;
  searchUsers: (event: ChangeEvent<HTMLInputElement>) => void;
  logs: EntryLogs[];
  endWorkDay: ()=>void
  addUser:(id:string)=>void
}

export interface FirstPageProps {
  users: AddNewUser[];
  valueInput: string;
  addUsersInput: (event: ChangeEvent<HTMLInputElement>) => void;
  addUser: () => void;
  deleteUser: (id: string) => void;
}
