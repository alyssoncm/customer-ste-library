import { User } from "app/services/users.service";
import { IEntity, IFile } from "./entity.interface";

export class EntityObject {
    public entity: IEntity;
    public classname: string;
    // public entityProperties: string[];
    // public entityArrayProperties: string[]
    public updatedBy?: User;
    public createdBy?: User;
    public updatedAt?: Date;
    public createdAt?: Date;
}

export class EntityFile {
    public entity: IFile;
    public url : string;
    public name : string;
    public fileName: string;
}