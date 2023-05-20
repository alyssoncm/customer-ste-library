import { Injectable } from "@angular/core";
import { IEntity } from "app/models/DataEntities/entity.interface";
import { environment } from "environments/environment";
import * as Parse from 'parse';
import { ParseRoleManger } from "./roles.service";
import { ParseDataService } from "./data.service";

export class User extends Parse.User {
    username?: string;
    email?: string;
    password?: string;
    role?: string;
    entity: IEntity;
    id: string;
}

export interface UserService {
    signup(username: string, password: string, email: string, role: string[]): Promise<User>;
    login(username: string, password: string): Promise<User>;
    getCurrentUser(): User | undefined;
}

@Injectable({
    providedIn: 'root'
})
export class ParseUserService implements UserService {
    currentSession: Parse.Session;
    constructor(protected _roleService: ParseRoleManger) {
        Parse.initialize(`${environment.APPLICATION_ID}`, `${environment.JAVASCRIPT_KEY}`);  // use your appID & your js key
        (Parse as any).serverURL = `${environment.parseUrl}`; // use your server url
        (Parse as any).liveQueryServerURL = `${environment.LIVE_QUERY_SERVER}`;
    }

    protected mapParseUserToUser(user: Parse.User) {
        let mappedUser: User = new User();
        mappedUser.email = user.getEmail();
        mappedUser.username = user.getUsername();
        mappedUser.role = user.get("role");
        mappedUser.entity = user;
        mappedUser.id = user.id;
        return mappedUser;
    }

    async signup(username: string, password: string, email: string, role?: string[]) {
        let user = new Parse.User();
        user.set("username", username);
        user.set("password", password);
        user.set("email", email);
        const rolesQuery = new Parse.Query(Parse.Role);
        rolesQuery.equalTo("name", role);
        let roles = await rolesQuery.find();
        user = await user.signUp();
        for (let role of roles as Parse.Role[]) {
            role.getUsers().add(user);
            role.save();
        }
        return this.mapParseUserToUser(user);
    }

    async login(username: string, password: string) {
        const user = await Parse.User.logIn(username, password);
        return this.mapParseUserToUser(user);
    }

    getCurrentUser() {
        let currentUser = Parse.User.current();
        if (currentUser)
            return this.mapParseUserToUser(currentUser);
        return undefined;
    }

    async checkSessionValidity() {
        let currentUser = await Parse.User.current();
        if (currentUser) {
            let query = new Parse.Query(Parse.User);
            return query.get(currentUser!.id).then((res) => {
                return res;
            },
                (err) => {
                    switch (err.code) {
                        case Parse.Error.INVALID_SESSION_TOKEN:
                            console.log("Invalid Session, need to log in again!")
                            Parse.User.logOut();
                            window.location.reload();
                            return undefined;
                    }
                }
            );
        } else {
            return currentUser;
        }
    }

    logout() {
        Parse.User.logOut().then(() => {

        })
    }

    public async save(user: User) {
        return this.mapParseUserToUser(await (user.entity as Parse.User).save());
    }
}