import { Injectable } from "@angular/core";
import { EntityObject } from "../models/DataEntities/entityObjects.model";
import { ParseUserService, User } from "./users.service";
import * as Parse from 'parse';
import { ParseDataService } from "./data.service";

export class Role extends EntityObject {
    name: string;
    users: User[] = [];
    roles: Role[] = [];
}

export interface RoleManager {
    createRole(roleName: string, users?: User[], childrenRoles?: Role[], parentRole?: Role | undefined): Promise<Role>;
    addUserToRole(role: Role, user: User): User;
    changeUserRole(newRole: Role, user: User): User;
    findByName(roleName: string): Role;
}

@Injectable({
    providedIn: 'root'
})
export class ParseRoleManger extends ParseDataService<Role> implements RoleManager {
    private activeRoles: Role[];
    private activerRoles$: Promise<Role[]>;
    constructor() {
        super({ classname: "_Role", type: Role });
    }

    addUserToRole(role: Role, user: User): User {
        throw new Error("Method not implemented.");
    }
    findByName(roleName: string): Role {
        throw new Error("Method not implemented.");
    }
    async createRole(roleName: string, users?: User[], childrenRoles?: Role[], parentRole?: Role | undefined): Promise<Role> {
        let newRole = new Role();
        if (childrenRoles)
            newRole.roles = childrenRoles;
        if (users)
            newRole.users = users;
        newRole.name = roleName;
        newRole = await this.save(newRole);
        if (parentRole) {
            let role = parentRole.entity as Parse.Role;
            role.getRoles().add(role);
            parentRole.entity = await role.save();
        }
        return newRole;
    }
    changeUserRole(newRole: Role, user: User): User {
        throw new Error("Method not implemented.");
    }

    public async getActiveRoles(): Promise<Role[]> {
        if (!this.activerRoles$) {
            this.activerRoles$ = Parse.Cloud.run('getUserRoles', {}).then(async (roles: Parse.Role[]) => {
                this.activeRoles = await Promise.all(roles.map(x => this.mapParseAttributesToEntityObject(x)));
                return this.activeRoles;
            });
        }
        if (!this.activeRoles)
            await this.activerRoles$;

        return this.activeRoles;
    }

    public async getUsersWithoutRole(roles: string[] | Role[]): Promise<User[]> {
        let roleNamesToExclude: string[];
        try {
            (roles as Role[]).forEach(role => {
                roleNamesToExclude.push(role.name);
            });
        } catch (err) {
            roleNamesToExclude = roles as string[];
        }
        throw new Error("Method not implemented.");
    }

    public async isCurrentUserACustomer() {
        if ((await this.getActiveRoles()).find(role => role.name == "SC" || role.name == 'admin' || role.name == 'supervisor')) {
            return false;
        } else {
            return true;
        }
    }
}