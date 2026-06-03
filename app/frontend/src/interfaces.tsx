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

export interface ConnectionResponse {
  connected: boolean;
  connectedLock: boolean;
}

export interface ThirdPageProps {
  counterIn:number;
  counterOut:number;
  setLimitUsers: (arg:number)=>void;
  currentLimit: number;
  currentUsersIn:number;
  currentUsersOut:number;

  statusCardModule:boolean;
  statusMainLockModule:boolean;
  
  setIsEmergencyFunc:(arg:boolean)=>void;
  isEmergency:boolean;

  setIsAddingCardFunc:(arg:boolean)=>void;
  isAddingCard:boolean;
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
  searchUsers: (event: ChangeEvent<HTMLInputElement>) => void;
  valueInputSearchUsers:string;
  users: AddNewUser[];
  valueInput: string;
  addUsersInput: (event: ChangeEvent<HTMLInputElement>) => void;
  addUser: () => void;
  deleteUser: (id: string) => void;
}
