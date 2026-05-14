import { ChangeEvent } from "react";

export interface AddNewUser {
  _id: string;
  user_id: string;
}

export interface EntryLogs {
  _id: string;
  user_id: string;
  timestamp: string;
  isEntry: boolean;
}

export interface SecondPageProps {
  users: AddNewUser[];
  valueInputSearch: string;
  searchUsers: (event: ChangeEvent<HTMLInputElement>) => void;
  timestamp: string;
  logs: EntryLogs[];
}

export interface FirstPageProps {
  users: AddNewUser[];
  valueInput: string;
  addUsersInput: (event: ChangeEvent<HTMLInputElement>) => void;
  addUser: () => void;
  deleteUser: (id: string) => void;
}
