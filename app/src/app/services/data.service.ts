import * as Parse from 'parse';
import { EntityFile, EntityObject } from "../models/DataEntities/entityObjects.model";
import * as EventEmitter from "events";
import { IEntity } from "../models/DataEntities/entity.interface";
import { Classnames, EntityObjectDefinition } from 'app/shared/classnames.model';
import { environment } from 'environments/environment';
import { User } from './users.service';


export interface DataInterface<T extends EntityObject> {
  /**
   * It simply queries for al the objects of the ```type T```, no includes
   * @returns a ```list``` of objects of ```type T```
   */
  getAll(): Promise<T[]>;
  /**
   * It queries for all the elements of this class, including all the relations.
   * @returns a list of objects of ```type T```
   */
  getAllWithSubclasses(): Promise<T[]>;
  getAllWithIncludes(include: string[]): Promise<T[]>;
  /**
   *
   * @param entityObject the object we want to save. It **must be** from a **class extending EntityObject** (which contains an entity object implementing ```IEntity``` interface)
   * @returns the same object but with the IEntity property updated accordingly to the backend
   */
  save(entityObject: T): Promise<T>;
  /**
   *
   * @param entityObject the ```EntityObject``` that should be deleted from the database
   * @returns the delete object
   */
  destroy(entityObject: T): void;
  /**
   *
   * @param entityObject the ```EntityObject``` to update accordingly to fresher informations on the DB
   * @returns the refreshed object
   */
  fetch(entityObject: T): Promise<T>;
  /**
   * It can be used also as a harder fetch, including all the sub attributes and not only the main object
   * @param id the id of the object to download from the db
   * @returns the object with all the includes
   */
  getFullObjectById(id: any): Promise<T>;
  getFullObjectByIdWithIncludes(id: string, include: string[]): Promise<T | undefined>
  /**
   * ### Use Case
   * Since working with typescripts' deep copy would simply copy the object itself,
   * whenever i need a duplicated object on the db too this function must be called.
   * #### Use Case Example
   * For example, let's save i have ```Obj1: EntityObject``` istance and i want a ```Obj2: EntityObject``` istance that is
   * exactly identical to ```Obj1```, but that i can change independently so that any change made to ```Obj2``` won't
   * affect ```Obj1```.
   *
   * If i did something like:
   * ```
   * let Obj2: EntityObject = {...Obj1};
   * ```
   * i'd copy the full ```Obj1``` into ```Obj2```, also the ```entity: IEntity``` attribute.
   *
   * But since ```entity``` is used by the data service for tracking what object the istance is related to
   * on the db, calling ```dataService.save(Obj2);``` would make dataservice work with the exact same entity
   * as ```Obj1``` thus affecting also ```Obj1```. In this scenario, you make think of ```Obj1``` and ```Obj2``` as 2 pointers
   * to the same db record.
   *
   * If i want to ```Obj2``` to be a completely new and indipendent, object we need it to omit the ```entity``` field during
   * the copy. Since the programmer should not care about this detail when working with this architecture,
   * he can simply do the following call:
   * ```
   * let Obj2: EntityObject = dataService.duplicate(Obj1);
   * ```
   * Now ```Obj2``` is a new object missing entity attribute, which will be assigned after the first ```dataService.save()``` call like
   * if we just did a ```new EntityObject();``` call.
   * @param entityObject (param entityObject) the EntityObject to duplicate
   * @returns the new duplicated object, missing the entity field.
   */
  duplicate(entityObject: T): Promise<T>;

  fetchById(id: string): Promise<T>;

  setACLByActiveUser(entityObject: T): Promise<T>;
  setACLByRole(role: string): Promise<T>;
}

/**
 * Data interface implementation for Parse Server
 */
export class ParseDataService<T extends EntityObject> implements DataInterface<T> {
  protected classType: { new(): T };
  protected classname: string;


  protected initialBufferQuery: Parse.Query | undefined;
  protected bufferQuery: Parse.Query | undefined;
  protected bufferSuccessMessage: string;

  protected dataBuffer: { [key: string]: T };
  // protected unindexedBufferData: T[];
  protected dataBuffer$: Promise<void>;

  private parseSubscription: Parse.LiveQuerySubscription;
  protected externalSubscription: EventEmitter;
  externalSubscription$: Promise<EventEmitter>;
  protected startLiveQuery?: boolean = true;

  protected queryLimit = 100000;
  public constructor(entityClass: EntityObjectDefinition<T>) {
    Parse.initialize(`${environment.APPLICATION_ID}`, `${environment.JAVASCRIPT_KEY}`);  // use your appID & your js key
    (Parse as any).serverURL = `${environment.parseUrl}`; // use your server url
    (Parse as any).liveQueryServerURL = `${environment.LIVE_QUERY_SERVER}`;
    Parse.enableLocalDatastore();
    this.classType = entityClass.type;
    this.classname = entityClass.classname;

    this.bufferQuery = new Parse.Query(this.classname);
    this.bufferQuery.exclude("ACL");
    this.bufferQuery.includeAll();
  }

  protected async afterBufferDownload(parseObjects: Parse.Object[]): Promise<T[]> {
    return this.mapParseArrayOfAttributesToEntityObject(parseObjects, 0, 2);
  }
  protected async afterSubUpdate(parseObject: Parse.Object): Promise<T | undefined> {
    console.log("Aggiornamento", this.classname, parseObject);
    return this.mapParseAttributesToEntityObject(parseObject);
  }

  protected async startupBuffer(notificationMessage?: string): Promise<void> {
    if (!this.bufferQuery)
      return;
    const currentUser = Parse.User.current();
    if (!currentUser) {
      return;
    }
    const activeSessionToken: string = currentUser.getSessionToken();

    let query$: Promise<Parse.Object<Parse.Attributes>[]>;
    if (!this.initialBufferQuery) {
      query$ = this.bufferQuery.limit(this.queryLimit).find();
    } else {
      query$ = this.initialBufferQuery.limit(this.queryLimit).find();
    }

    let dataBuffer$ = query$.then(async (res) => {
      // this.dataBuffer = (await this.afterBufferDownload(res));
      // wait for afterBufferDownload of res and map it to this.dataBuffer using the id as key
      this.dataBuffer = {};
      let unindexedBufferData = await this.afterBufferDownload(res);
      unindexedBufferData.forEach((x) => {
        this.dataBuffer[x.entity.id] = x;
      });

      if (!notificationMessage)
        notificationMessage = this.classname;

      this.externalSubscription$ = this.bufferQuery!.subscribe(activeSessionToken).then((res) => {
        this.externalSubscription = new EventEmitter();
        this.parseSubscription = res;

        this.parseSubscription.on('open', (object) => {
          console.log("Livequery enabled for", this.classname);
        });
        this.parseSubscription.on('create', async (object) => {
          let updated = await this.afterSubUpdate(object);
          if (!updated)
            return;
          // this.unindexedBufferData!.push(updated);
          this.dataBuffer[updated.entity.id] = updated;
          this.externalSubscription.emit('create', updated);
        });
        this.parseSubscription.on('update', async (object) => {
          if (this.dataBuffer) {
            let updated = await this.afterSubUpdate(object);
            if (!updated)
              return;
            // let old_object = this.unindexedBufferData.find(x => x.entity.id == object.id);
            // if (old_object) {
            //   let index = this.unindexedBufferData.indexOf(old_object);
            //   this.dataBuffer[index] = updated;
            // }
            this.dataBuffer[updated.entity.id] = updated;
            this.externalSubscription.emit('update', updated);
          }
        });
        this.parseSubscription.on('enter', async (object) => {
          let updated = await this.afterSubUpdate(object);
          if (!updated)
            return;
          // this.unindexedBufferData!.push(updated);
          this.dataBuffer[updated.entity.id] = updated;
          this.externalSubscription.emit('enter', updated);
        });

        this.parseSubscription.on('leave', (object) => {
          // let index = this.unindexedBufferData!.indexOf(this.unindexedBufferData!.find(x => x.entity.id == object.id)!);
          // this.unindexedBufferData!.splice(index, 1);
          this.externalSubscription.emit('leave', this.dataBuffer[object.id]);
          delete this.dataBuffer[object.id];
        });

        this.parseSubscription.on('delete', (object) => {
          // let index = this.unindexedBufferData!.indexOf(this.unindexedBufferData!.find(x => x.entity.id == object.id)!);
          // this.unindexedBufferData!.splice(index, 1);
          this.externalSubscription.emit('delete', this.dataBuffer[object.id]);
          delete this.dataBuffer[object.id];
        });
        return this.externalSubscription;
      });
      return;
    },
      (error) => {
        console.log("Error in startupBuffer for", this.classname, error);
        this.dataBuffer = {};
        this.externalSubscription$ = Promise.resolve(new EventEmitter());
        return;
      });

    return dataBuffer$;
  }


  protected updateAttributeOnSubscriptionUpdate<K extends keyof T, T2 extends T[K]>(attribute: K, object: T, reference: T2): T {
    object[attribute] = reference;
    return object;
  }
  protected updateAttributeOnSubscriptionDelete<K extends keyof T>(attribute: K, object: T): T {
    delete object[attribute];
    return object;
  }
  protected updateAttributeArrayOnSubscriptionUpdate<K extends keyof T, T2 extends EntityObject, T3 extends T2[]>(attribute: K, object: T, reference: T2): T {
    let arrayToUpdate = object[attribute] as unknown as T3;
    //TODO controllare se l'array sia da creare
    if (!arrayToUpdate) {
      // arrayToUpdate = [] as T2[] as T3;
      console.warn("The array on the object to update was not initialized yet.");
      return object;
    }
    let index = arrayToUpdate.findIndex(x => x.entity.id == reference.entity.id);
    if (index == -1)
      arrayToUpdate.push(reference);
    else
      arrayToUpdate[index] = reference;
    object[attribute] = arrayToUpdate as unknown as T[K];
    return object;
  }
  protected updateAttributeArrayOnSubscriptionDelete<K extends keyof T, T2 extends EntityObject, T3 extends T2[]>(attribute: K, object: T, reference: T2): T {
    let arrayToUpdate = object[attribute] as unknown as T3;
    if (!arrayToUpdate) {
      return object;
    }
    let index = arrayToUpdate.findIndex(x => x.entity.id == reference.entity.id);
    if (index != -1)
      arrayToUpdate.splice(index, 1);
    object[attribute] = arrayToUpdate as unknown as T[K];
    return object;
  }

  protected async subscripeAttributeUpdate(attributeToSubscribe: keyof T,
    queryToLookAt: EventEmitter,
    findObjectToUpdateCallback: (attribute: keyof T, object: T[keyof T]) => Promise<T | undefined>) {

    queryToLookAt.on('update', async (object: T[keyof T]) => {
      let updatedObject = await findObjectToUpdateCallback(attributeToSubscribe, object);
      if (updatedObject) {
        updatedObject = this.updateAttributeOnSubscriptionUpdate(attributeToSubscribe, updatedObject, object);
        this.dataBuffer[updatedObject.entity.id] = updatedObject;
        if (this.externalSubscription)
          this.externalSubscription.emit('update', updatedObject);
      }
    });


    queryToLookAt.on('create', async (object: T[keyof T]) => {
      let updatedObject = await findObjectToUpdateCallback(attributeToSubscribe, object);
      if (updatedObject) {
        updatedObject = this.updateAttributeOnSubscriptionUpdate(attributeToSubscribe, updatedObject, object);
        this.dataBuffer[updatedObject.entity.id] = updatedObject;
        if (this.externalSubscription)
          this.externalSubscription.emit('update', updatedObject);
      }
    });

    queryToLookAt.on('enter', async (object: T[keyof T]) => {
      let updatedObject = await findObjectToUpdateCallback(attributeToSubscribe, object);
      if (updatedObject) {
        updatedObject = this.updateAttributeOnSubscriptionUpdate(attributeToSubscribe, updatedObject, object);
        this.dataBuffer[updatedObject.entity.id] = updatedObject;
        if (this.externalSubscription)
          this.externalSubscription.emit('update', updatedObject);
      }
    });

    queryToLookAt.on('delete', async (object: T[keyof T]) => {
      let updatedObject = await findObjectToUpdateCallback(attributeToSubscribe, object);
      if (updatedObject) {
        updatedObject = this.updateAttributeOnSubscriptionDelete(attributeToSubscribe, updatedObject);
        this.dataBuffer[updatedObject.entity.id] = updatedObject;
        if (this.externalSubscription)
          this.externalSubscription.emit('update', updatedObject);
      }
    });

    queryToLookAt.on('leave', async (object: T[keyof T]) => {
      let updatedObject = await findObjectToUpdateCallback(attributeToSubscribe, object);
      if (updatedObject) {
        updatedObject = this.updateAttributeOnSubscriptionDelete(attributeToSubscribe, updatedObject);
        this.dataBuffer[updatedObject.entity.id] = updatedObject;
        if (this.externalSubscription)
          this.externalSubscription.emit('update', updatedObject);
      }
    });
  }

  protected async subscripeAttributeArrayUpdate<T2 extends EntityObject, T3 extends T2[]>(attributeToSubscribe: keyof T,
    queryToLookAt: EventEmitter,
    findObjectToUpdateCallback: (attribute: keyof T, object: T2) => Promise<T | undefined>) {

    queryToLookAt.on('update', async (object: T2) => {

      let updatedObject = await findObjectToUpdateCallback(attributeToSubscribe, object);
      if (updatedObject) {
        updatedObject = this.updateAttributeArrayOnSubscriptionUpdate(attributeToSubscribe, updatedObject, object);
        this.dataBuffer[updatedObject.entity.id] = updatedObject;
        if (this.externalSubscription)
          this.externalSubscription.emit('update', updatedObject);
      }
    });


    queryToLookAt.on('create', async (object: T2) => {

      let updatedObject = await findObjectToUpdateCallback(attributeToSubscribe, object);
      if (updatedObject) {
        updatedObject = this.updateAttributeArrayOnSubscriptionUpdate(attributeToSubscribe, updatedObject, object);
        this.dataBuffer[updatedObject.entity.id] = updatedObject;
        if (this.externalSubscription)
          this.externalSubscription.emit('update', updatedObject);
      }
    });

    queryToLookAt.on('enter', async (object: T2) => {

      let updatedObject = await findObjectToUpdateCallback(attributeToSubscribe, object);
      if (updatedObject) {
        updatedObject = this.updateAttributeArrayOnSubscriptionUpdate(attributeToSubscribe, updatedObject, object);
        this.dataBuffer[updatedObject.entity.id] = updatedObject;
        if (this.externalSubscription)
          this.externalSubscription.emit('update', updatedObject);
      }
    });

    queryToLookAt.on('delete', async (object: T2) => {
      
      let updatedObject = await findObjectToUpdateCallback(attributeToSubscribe, object);
      if (updatedObject) {
        updatedObject = this.updateAttributeArrayOnSubscriptionDelete(attributeToSubscribe, updatedObject, object);
        this.dataBuffer[updatedObject.entity.id] = updatedObject;
        if (this.externalSubscription)
          this.externalSubscription.emit('update', updatedObject);
      }
    });

    queryToLookAt.on('leave', async (object: T2) => {

      let updatedObject = await findObjectToUpdateCallback(attributeToSubscribe, object);
      if (updatedObject) {
        updatedObject = this.updateAttributeArrayOnSubscriptionDelete(attributeToSubscribe, updatedObject, object);
        this.dataBuffer[updatedObject.entity.id] = updatedObject;
        if (this.externalSubscription)
          this.externalSubscription.emit('update', updatedObject);
      }
    });
  }

  public async getIndexedBufferedData(): Promise<{ [key: string]: T }> {
    if (!this.bufferQuery || !this.startLiveQuery) {
      let query: Parse.Query;
      if (this.initialBufferQuery)
        query = this.initialBufferQuery;
      else
        query = new Parse.Query(this.classname).includeAll();

      this.dataBuffer$ = query.find().then(async (res) => {
        let unindexedBufferData = await this.afterBufferDownload(res);
        this.dataBuffer = {};
        unindexedBufferData.forEach((x) => {
          this.dataBuffer[x.entity.id] = x;
        });
      },
        (err) => {
          this.dataBuffer = {};
          console.error("Error in fetching info for buffer", err);
        })
    }
    if (this.dataBuffer$ == undefined) {
      this.dataBuffer$ = this.startupBuffer(this.bufferSuccessMessage);
    }
    await this.dataBuffer$;
    return this.dataBuffer;
  }
  /**
   * 
   * @returns if **bufferQuery** iss defined, the local dataBuffer automatically updated via liveQuery. Otherwise, the local dataBuffer (no updates, **data need to be refetched manually**).
   */
  public async getBufferedData(): Promise<T[]> {
    return Object.values(await this.getIndexedBufferedData());
  }

  public async startUpLiveQuery(): Promise<void> {
    await this.dataBuffer$;
    await this.externalSubscription$;
    await this.getIndexedBufferedData();
    return;
  }


  public async getSubscription(): Promise<EventEmitter> {
    await this.getBufferedData();
    await this.dataBuffer$;
    let returnValue = await this.externalSubscription$;
    return returnValue;
  }

  public unsubscribeLiveQuery(): void {
    if (this.parseSubscription) {
      this.parseSubscription.unsubscribe();
    }
  }


  private mapTypescriptAttributeToParseObjectAttribute(attribute: any) {
    if (attribute instanceof EntityObject || attribute instanceof Object && attribute.entity != undefined) {
      return attribute.entity;
    }
    if (attribute instanceof EntityFile) {
      return attribute.entity;
    }
    if (attribute instanceof Parse.Object || attribute instanceof Parse.File || attribute instanceof Parse.User || attribute instanceof Parse.Role) {
      return attribute;
    }
    return attribute;
  }

  /**
   * @deprecated used for retro-compatibility with old mapping only
   * @param attribute 
   * @returns 
   */
  private checkIfIndexingIsNeeded(attribute: any) {
    if (attribute instanceof EntityObject || attribute instanceof Object && attribute.entity != undefined) {
      return true;
    }
    if (attribute instanceof EntityFile) {
      return true;
    }
    if (attribute instanceof Parse.Object || attribute instanceof Parse.File || attribute instanceof Parse.User || attribute instanceof Parse.Role) {
      return true;
    }
    return false;
  }


  private mappings(entityObject: T): Parse.Object {
    const entity: keyof EntityObject = 'entity';

    let parseObject: Parse.Object;
    if (entityObject[entity] != undefined) {
      parseObject = entityObject[entity] as Parse.Object;
    } else {
      parseObject = new Parse.Object(this.classname);
      parseObject.set("classname", this.classname);
    }
    let property: keyof typeof entityObject;

    /**
     * @deprecated used for retro-compatibility with old mapping only
     */
    let entityArrayProperties: string[] = [];
    /**
     * @deprecated used for retro-compatibility with old mapping only
     */
    let entityProperties: string[] = [];

    for (property in entityObject) {
      if (property == entity) {
        continue;
      }

      if (entityObject[property] != undefined) {
        if (Array.isArray(entityObject[property])) {
          const parseAttributes = (entityObject[property] as unknown as any[]).map((x) => this.mapTypescriptAttributeToParseObjectAttribute(x));
          // Using addAllUnique is a great way to avoid conflicts, since it's an "atomic operation" and prevents adding duplicates.
          // Given that the usage of our library is 1) save the object 2) add it as a pointer, it's totally fine using this method with pointers.
          if (parseAttributes.length > 0 && parseAttributes[0] instanceof Parse.Object) {
            
            if (parseObject.get(property)) {
              // Now let's make sure we filter out the ones that were eventually "deleted" from the array:
              const toRemove = (parseObject.get(property) as Parse.Object[]).filter((x) => !parseAttributes.some((y) => y.id == x.id));
              // and check which ones are to add:
              const toAdd = parseAttributes.filter((x) => !(parseObject.get(property as string) as Parse.Object[]).some((y) => y.id == x.id));

              for (let x of toAdd) {
                const res = parseObject.addUnique(property, x);
                if (res) {
                  parseObject = res;
                } else {
                  throw Error("Error in adding element to array");
                }
              }
              for (let x of toRemove) {
                const res = parseObject.remove(property, x);
                if (res) {
                  parseObject = res;
                } else {
                  throw Error("Error in removing element from array");
                }
              }
            } else {
              // let's add all the elements to save within the array
              parseObject.addAllUnique(property, parseAttributes);
            }
          }
          // Else, we have to use, for now, the set. This is because we don't have a way to check if the array contains duplicates.
          // This is a problem, because if we use set, we will overwrite the array, and we may hve overwriting issues. But after all,
          // this is a problem of the user, not of the library, since it's not supposed to be a protocol/standard/whatever.
          else
            parseObject.set(property, parseAttributes);
          if ((entityObject[property] as unknown as any[]).some(x => this.checkIfIndexingIsNeeded(x))) {
            entityArrayProperties.push(property);
          }
        } else {
          const parseAttribute = this.mapTypescriptAttributeToParseObjectAttribute(entityObject[property]);
          parseObject.set(property, parseAttribute);
          if (this.checkIfIndexingIsNeeded(entityObject[property])) {
            entityProperties.push(property);
          }
        }
      }
      if (entityObject[property] == undefined) {
        parseObject.unset(property);
      }
    }
    parseObject.set("entityArrayProperties", entityArrayProperties);
    parseObject.set("entityProperties", entityProperties);
    return parseObject;
    // I need to remove the _entity attribute from the object so that i can save just the model
    // So first of all i translate it to something i can manipulate

    // const m: any = {};
    // let entityProperties: string[] = [];
    // let entityArrayProperties: string[] = [];
    // let property: keyof typeof entityObject;

    // for (property in entityObject) {
    //   let p: string = property.toLocaleLowerCase();
    //   // I skip all the inner _entity attrivute, which should not be passed when saving
    //   if (entityObject[property] != undefined && p != 'entity') {
    //     // I make sure all the relations are treated correctly
    //     if ((entityObject[property] as any).hasOwnProperty("entity")) {
    //       let eo: T = (entityObject[property] as any as T);
    //       m[property] = eo.entity;
    //       entityProperties.push(property);
    //     } else {
    //       //TODO check correct naming
    //       if (Object.prototype.toString.call(entityObject[property] as any).includes(Array.name)) {
    //         //In this case i have an array of objects. Is it an array of objects i need to set a relation for?
    //         try {
    //           if ((entityObject[property] as any as any[]).length > 0 && (entityObject[property] as any as any[])[0].hasOwnProperty("entity")) {
    //             // I save an array of Parse.Objects for this property. This allows a relation one-to-many!
    //             m[property] = (entityObject[property] as any as any[] as EntityObject[]).map(x => x.entity);
    //             entityArrayProperties.push(property);
    //           }
    //           else {
    //             m[property] = entityObject[property];
    //           }
    //         } catch (err) {
    //           console.warn(err);
    //         }
    //       } else {
    //         if (p == 'id') {
    //           m["o_id"] = entityObject[property];
    //         } else {
    //           m[property] = entityObject[property];
    //         }
    //       }
    //     }
    //   }
    //   if (entityObject[property] == null && p != 'entity') {
    //     m[property] = null;
    //   }
    // }
    // m["entityProperties"] = entityProperties;
    // m["entityArrayProperties"] = entityArrayProperties;
    // return m;
  }
  /**
   *
   * @param entityObject the object we want to save. It **must be** from a **class extending EntityObject** (which contains an entity object implementing ```IEntity``` interface)
   * @returns the same object but with the ```IEntity``` property updated accordingly to the backend
   */
  async save(entityObject: T): Promise<T> {

    // First of all i check if is there an entity already connected
    // to that object
    // if (!entityObject.entity) {
    //   //if it's not instantieted yet i save create a new one
    //   entityObject.entity = this.getNewEntity();
    //   entityObject.classname = this.classname;
    // }
    // if (!(entityObject.entity as Parse.Object).className) {
    //   (entityObject.entity as Parse.Object).className = this.classname;
    //   (entityObject.entity as Parse.Object).set("className", this.classname);
    // }

    let parseObject = this.mappings(entityObject);

    let savedEntity = await parseObject.save().then(async (res) => {
      return res;
    }, (err) => {
      console.error("Error in saving entity", err);
      return undefined;
    });

    if (!savedEntity) {
      return entityObject;
    }

    entityObject.entity = savedEntity;
    return entityObject as T;
  }

  /**
   *
   * @param entityObject the EntityObject that should be deleted from the database
   * @returns the delete object
   */
  async destroy(entityObject: T): Promise<T> {
    if (!entityObject.entity) {
      throw "Entity not found";
    }
    const returnValue = await (entityObject.entity as Parse.Object).destroy().then((res) => {
      return this.mapParseAttributesToEntityObject(res);
    }, (err) => {
      console.error("Error in deleting entity", err);
      throw Error("Error in deleting entity");
    });
    return returnValue;
  }

  /**
   * This is a factory, should not be used outside.
   * @returns a new IEntity object
   */
  getNewEntity(): Parse.Object {
    const parseEntity = new Parse.Object(this.classname);
    return parseEntity;
  }
  /**
   * Same as getNewEntity but with custom class
   * @param classname the classname for which we are creating a new IEntity object
   * @returns a new IEntity object
   */
  getNewCompatibleEntityOfAnyType(classname: string): Parse.Object {
    const ParseEntity = Parse.Object.extend(classname);
    return new ParseEntity();
  }

  protected mapFile(parseFile: Parse.File): EntityFile {
    let newFile: EntityFile = new EntityFile();
    newFile.name = parseFile.name();
    // newFile.data = await parseFile.getData();
    newFile.url = parseFile.url();
    newFile.entity = parseFile;
    return newFile;
  }

  protected mapParseUserToUser(user: Parse.User) {
    let mappedUser: User = new User();
    // mappedUser = {...user} as User;
    mappedUser.email = user.getEmail();
    mappedUser.username = user.getUsername();
    mappedUser.role = user.get("role");
    mappedUser.entity = user;
    mappedUser.id = user.id;
    return mappedUser;
  }

  // protected mapParseRoleToRole(role: Parse.Role) {
  //   let mappedRole: Role = new Role();
  //   mappedRole.name = role.getName();
  //   mappedRole.entity = role;
  //   return mappedRole;
  // }

  /**
   * This function is mean to be used to map the Parse.Object<Parse.Attributes> return
   * values from a query into any model we intend to actually use in the program.
   * @param parseElement like a queried element
   * @returns a mapped model
   */
  protected mapParseAttributesToEntityObject<K extends keyof Classnames, E extends EntityObject, KE extends keyof E>(parseElement: Parse.Object<Parse.Attributes>, deepLevel: number = 0, maxDeep: number = 3): any | undefined {
    if (!parseElement)
      return undefined;
    const classname: K = parseElement.className as K;

    const classReference: EntityObjectDefinition<E> = Classnames[classname];
    if (!classReference) {
      console.error("Classname not found", classname, "for", parseElement);
      return undefined;
    }
    if (typeof classReference === "string") {
      if (classReference === "_User") {
        return this.mapParseUserToUser(parseElement as Parse.User);
      }
      else if (classReference === "File") {
        return this.mapFile(parseElement as any as Parse.File);
      }
    }
    if (!classReference.type) {
      console.error("Class type not found", classname, "for", parseElement);
      return undefined;
    }
    const m: E = new classReference.type();
    if (maxDeep != deepLevel) {
      Object.keys(parseElement.attributes).forEach((element) => {
        let property = element as KE;
        if (parseElement.attributes[element] instanceof Parse.File) {
          (m[property] as any) = this.mapFile(parseElement.attributes[element] as Parse.File);
        }
        else if (parseElement.attributes[element] instanceof Parse.Object) {
          m[property] = this.mapParseAttributesToEntityObject(parseElement.attributes[element] as Parse.Object, deepLevel + 1, maxDeep);
        }
        else if (parseElement.attributes[element] instanceof Array && parseElement.attributes[element].length > 0 && parseElement.attributes[element][0] instanceof Parse.Object) {
          (m[property] as any) = this.mapParseArrayOfAttributesToEntityObject(parseElement.attributes[element] as Parse.Object[], deepLevel + 1, maxDeep);
        }
        else if (parseElement.attributes[element] instanceof Parse.User) {
          (m[property] as any) = this.mapParseUserToUser(parseElement.attributes[element] as Parse.User);
        }
        else if (parseElement.attributes[element] instanceof Parse.Role) {
          (m[property] as any) = this.mapParseAttributesToEntityObject(parseElement.attributes[element] as Parse.Role, deepLevel + 1, maxDeep);
        } else {
          m[property] = parseElement.attributes[element];
        }

      });
    }
    // m = { ...parseElement.attributes } as E;
    // let m = new classReference.type();
    // m will be the "m odel" we are constructing
    // We create the corresponding entity we will add to our m odel at the end
    // let et: Parse.Object = this.getNewCompatibleEntityOfAnyType(parseElement.className);
    // et.id = parseElement.id;
    // try {
    //   if (maxDeep != deepLevel) {
    //     for (let entityProperty of m.entityProperties as KE[]) {
    //       m[entityProperty] = this.mapParseAttributesToEntityObject(parseElement.attributes[entityProperty as string], deepLevel + 1, maxDeep);
    //     }
    //     for (let entityArrayProperty of m.entityArrayProperties as KE[]) {
    //       (m[entityArrayProperty] as any) = this.mapParseArrayOfAttributesToEntityObject(parseElement.attributes[entityArrayProperty as string], deepLevel + 1, maxDeep);
    //     }
    //   }
    // } catch (err) {
    //   Object.entries(parseElement.attributes).map((x) => {
    //     if (!x[1])
    //       return;
    //     let attributeClassName = Object.getPrototypeOf(x[1]).constructor.name as string;
    //     if (attributeClassName.includes(Parse.Object.name) && x[1].hasOwnProperty('id')) {
    //       let subObject: any | undefined = this.mapParseAttributesToEntityObject(x[1], deepLevel + 1, maxDeep);
    //       m[x[0] as KE] = subObject;
    //     } else if (attributeClassName.includes(Parse.File.name)) {
    //       let subObject: EntityFile = this.mapFile(x[1]);
    //       (m as any)[x[0]] = subObject;
    //     } else if (attributeClassName.includes(Parse.User.name)) {
    //       let subObject: User = this.mapParseUserToUser(x[1]);
    //       (m as any)[x[0]] = subObject;
    //     } else {
    //       if (Object.getPrototypeOf(x[1]).constructor.name.includes(Array.name)) {
    //         //Let's check if it is an array of relations:
    //         if ((x[1] as any as any[]).length > 0 &&
    //           Object.getPrototypeOf(x[1][0]).constructor.name.includes(Parse.Object.name) && x[1][0].hasOwnProperty('id')) {
    //           let entities = [];
    //           for (let et of (x[1] as any as any[])) {
    //             entities.push(this.mapParseAttributesToEntityObject(et, deepLevel + 1, maxDeep));
    //           }
    //           (m as any)[x[0]] = entities;
    //         }
    //       }
    //     }
    //   });
    // }
    m["entity"] = parseElement;
    return m;
  }

  protected mapParseArrayOfAttributesToEntityObject(parseElements: Parse.Object<Parse.Attributes>[], deepLevel: number = 0, maxDeep: number = 2): any[] {
    // let ms = parseElements.map((parseElement) => {
    //   let m: any = { ...parseElement.attributes };
    //   // let et: Parse.Object = this.getNewCompatibleEntityOfAnyType(parseElement.className);
    //   // et.id = parseElement.id;

    //   try {
    //     if (maxDeep != deepLevel) {
    //       let entityProperties: string[] = m.entityProperties;// as any as any[];
    //       let entityArrayProperties: string[] = m.entityArrayProperties;// as any as any[];
    //       for (let entityProperty of entityProperties) {
    //         //Need to fetch the objects first to go further in most cases
    //         m[entityProperty] = this.mapParseAttributesToEntityObject(m[entityProperty], deepLevel + 1, maxDeep);
    //       }
    //       for (let entityArrayProperty of entityArrayProperties) {
    //         m[entityArrayProperty] = this.mapParseArrayOfAttributesToEntityObject(m[entityArrayProperty], deepLevel + 1, maxDeep);
    //       }
    //     }
    //   } catch (err) {
    //     Object.entries(parseElement.attributes).map((x) => {
    //       if (!x[1])
    //         return;
    //       let attributeClassName = Object.getPrototypeOf(x[1]).constructor.name as string;
    //       if (attributeClassName.includes(Parse.Object.name) && x[1].hasOwnProperty('id')) {
    //         let subObject: any | undefined = this.mapParseAttributesToEntityObject(x[1], deepLevel + 1, maxDeep);
    //         m[x[0]] = subObject;
    //       } else if (attributeClassName.includes(Parse.File.name)) {
    //         let subObject: EntityFile = this.mapFile(x[1]);
    //         m[x[0]] = subObject;
    //       } else if (attributeClassName.includes(Parse.User.name)) {
    //         let subObject: User = this.mapParseUserToUser(x[1]);
    //         m[x[0]] = subObject;
    //       } else {
    //         if (Object.getPrototypeOf(x[1]).constructor.name.includes(Array.name)) {
    //           //Let's check if it is an array of relations:
    //           if ((x[1] as any as any[]).length > 0 &&
    //             Object.getPrototypeOf(x[1][0]).constructor.name.includes(Parse.Object.name) && x[1][0].hasOwnProperty('id')) {
    //             let entities = [];
    //             for (let et of (x[1] as any as any[])) {
    //               entities.push(this.mapParseAttributesToEntityObject(et, deepLevel + 1, maxDeep));
    //             }
    //             m[x[0]] = entities;
    //           }
    //         }
    //       }
    //     });
    //   }
    //   m["entity"] = parseElement;
    //   return m;
    // });
    // return ms;
    if (maxDeep != deepLevel)
      return parseElements.map(parseElement => this.mapParseAttributesToEntityObject(parseElement, deepLevel));
    else
      return parseElements;
  }
  /**
   * It simply queries for al the objects of the ```type T```, no includes
   * @returns a ```list``` of objects of ```type T```
   */
  async getAll(): Promise<T[]> {
    const numberOfStuffToDownload = await new Parse.Query(this.classname).count().then((res) => {
      return res;
    },
      (err) => {
        console.error("Canno count available objects", err);
        console.warn("Trying to download all the objects using the set default limit in the service");
        return this.queryLimit;
      });
    const query = new Parse.Query(this.classname);
    let entityObjects = await query.limit(numberOfStuffToDownload).find().then((res) => {
      return res;
    },
      (err) => {
        console.error("Cannot download all the objects", err);
        return [];
      });

    return this.mapParseArrayOfAttributesToEntityObject(entityObjects);
    // return this.dataBuffer as T[];
  }
  /**
   * It queries for all the elements of this class, including all the relations.
   * @returns a list of objects of ```type T```
   */
  async getAllWithSubclasses(): Promise<T[]> {
    const numberOfStuffToDownload = await new Parse.Query(this.classname).count().then((res) => {
      return res;
    },
      (err) => {
        console.error("Canno count available objects", err);
        console.warn("Trying to download all the objects using the set default limit in the service");
        return this.queryLimit;
      });
    const query = new Parse.Query(this.classname).includeAll();
    let entityObjects = await query.limit(numberOfStuffToDownload).find().then((res) => {
      return res;
    },
      (err) => {
        console.error("Cannot download all the objects", err);
        return [];
      });

    return this.mapParseArrayOfAttributesToEntityObject(entityObjects);
  }

  async getAllWithIncludes(include: string[]): Promise<T[]> {

    const numberOfStuffToDownload = await new Parse.Query(this.classname).count().then((res) => {
      return res;
    },
      (err) => {
        console.error("Canno count available objects", err);
        console.warn("Trying to download all the objects using the set default limit in the service");
        return this.queryLimit;
      });

    // let ts: T[] = [];
    const query = new Parse.Query(this.classname);
    for (let i of include) {
      query.include(i);
    }

    let res = await query.limit(numberOfStuffToDownload).find().then((res) => {
      return res;
    },
      (err) => {
        console.error("Cannot download all the objects", err);
        return [];
      });

    return this.mapParseArrayOfAttributesToEntityObject(res);
    // return this.dataBuffer as T[];
  }

  async fetchAll(entityObjects: T[], include: string[]): Promise<T[]> {
    let res;
    entityObjects = entityObjects.filter(x => x != undefined);
    try {
      res = await Parse.Object.fetchAllWithInclude(entityObjects.map(x => x.entity) as Parse.Object[], include).then((res) => {
        return res;
      }
        // ,
        //   (err) => {
        //     console.error("Cannot fetch all the objects", err);
        //     return undefined;
        //   }
      );
    } catch (err) {
      res = await Parse.Object.fetchAllWithInclude(entityObjects as any as Parse.Object[], include).then((res) => {
        return res;
      }
        // , (err) => {
        //   console.error("Cannot fetch all the objects", err);
        //   return undefined;
        // }
      );
    }
    if (!res) return entityObjects;
    return this.mapParseArrayOfAttributesToEntityObject(res);
    // return this.dataBuffer as T[];
  }

  async fetchAllIfNeededWithIncludes(entityObjects: T[], include: string[]): Promise<T[]> {
    let res;
    entityObjects = entityObjects.filter(x => x != undefined);
    try {
      res = await Parse.Object.fetchAllIfNeededWithInclude(entityObjects.map(x => x.entity) as Parse.Object[], include).then((res) => {
        return res;
      }
        // ,
        //   (err) => {
        //     console.error("Cannot fetch all the objects", err);
        //     return undefined;
        //   }
      );
    } catch (err) {
      res = await Parse.Object.fetchAllIfNeededWithInclude(entityObjects as any as Parse.Object[], include).then((res) => {
        return res;
      }
        // , (err) => {
        //   console.error("Cannot fetch all the objects", err);
        //   return undefined;
        // }
      );
    }
    if (!res) return entityObjects;
    return this.mapParseArrayOfAttributesToEntityObject(res);
  }


  /**
   *
   * @param entityObject the EntityObject to update accordingly to fresher informations on the DB
   * @returns the refreshed object
   */
  async fetch(entityObject: T | IEntity): Promise<T> {
    let fetchedObject;
    if ((entityObject as T).entity) {
      fetchedObject = await ((entityObject as T).entity as Parse.Object).fetch().then((res) => {
        return res;
      },
        (err) => {
          console.error("Cannot fetch object", err);
          return undefined;
        })
    } else {
      fetchedObject = await (entityObject as IEntity as Parse.Object).fetch().then((res) => {
        return res;
      },
        (err) => {
          console.error("Cannot fetch object", err);
          return undefined;
        })
    }
    if (!fetchedObject) {
      if ((entityObject as T).entity) {
        return entityObject as T;
      } else {
        return this.mapParseAttributesToEntityObject(entityObject as IEntity as Parse.Object) as T;
      }
    }
    return this.mapParseAttributesToEntityObject(fetchedObject) as T;
  }

  /**
   * It can be used also as a harder fetch, including all the sub attributes and not only the main object.
   * getFullObjectById : fetch = DaniloFinizio : Rocco Siffredi
   * @param id the id of the object to download from the db
   * @returns the object with all the includes
   */
  async getFullObjectById(id: string): Promise<T> {
    const query = new Parse.Query(this.classname);
    let res$ = await query.includeAll().get(id).then((res) => {
      return res;
    },
      (err) => {
        console.error("Cannot download object", err);
        return undefined;
      });

    if (!res$) throw new Error("Error: Object not found.");

    let returnValue: T = new this.classType();
    returnValue = { ... this.mapParseAttributesToEntityObject(res$, 0, 3) as T };
    return returnValue as T;
  }

  async fetchObjectByIdIfNeeded(id: string): Promise<T | undefined> {
    if (!this.dataBuffer || Object.keys(this.dataBuffer).length == 0)
      return await this.getFullObjectById(id);
    let returnValue: T | undefined;
    try {
      // returnValue = (await this.getBufferedData()).find(x => x.entity.id == id);
      returnValue = this.dataBuffer[id];
      if (!returnValue) {
        returnValue = await this.getFullObjectById(id);
      }
    } catch (err) {
      try {
        returnValue = await this.getFullObjectById(id);
      } catch (err) {
        if ((err as Error).message.includes("Object not found.")) {
          return undefined;
        }
        console.error(err);
      }
    }
    return returnValue as T;
  }

  async fetchObjectIfNeeded(entityObject: T | IEntity): Promise<T | undefined> {
    if ((entityObject as T).entity) {
      return this.fetchObjectByIdIfNeeded((entityObject as T).entity.id);
    } else if ((entityObject as IEntity).id) {
      return this.fetchObjectByIdIfNeeded((entityObject as IEntity).id);
    } else {
      console.warn("Fetching object without id", entityObject);
      return undefined;
    }
  }

  fetchObjectByIdLocally(id: string): T | undefined {
    let returnValue: T | undefined;
    if (!this.dataBuffer)
      return returnValue;
    returnValue = this.dataBuffer[id];
    return returnValue;
  }
  fetchObjectLocally(entityObject: T | IEntity): T | undefined {
    if (!entityObject) return undefined;
    if ((entityObject as T)?.entity) {
      return this.fetchObjectByIdLocally((entityObject as T).entity.id);
    } else if ((entityObject as IEntity).id) {
      return this.fetchObjectByIdLocally((entityObject as IEntity).id);
    } else {
      console.warn("Fetching object without id", entityObject);
      return undefined;
    }
  }

  async getFullObjectByIdWithIncludes(id: string, include: string[], deepLevel = 2): Promise<T | undefined> {
    const query = new Parse.Query(this.classname);
    for (let i of include) {
      query.include(i);
    }
    let res$ = await query.get(id).then((res) => {
      return res;
    },
      (err) => {
        console.error("Cannot download object", err);
        return undefined;
      });
    if (!res$) return undefined;
    let returnValue: T = new this.classType();
    returnValue = { ... await this.mapParseAttributesToEntityObject(res$, 0, deepLevel) as T };
    return returnValue as T;
  }

  public async fetchFullObjectWithIncludes(entityObject: T | IEntity, include: string[], maxDeep = 2): Promise<T | undefined> {
    if ((entityObject as T).entity) {
      return this.getFullObjectByIdWithIncludes((entityObject as T).entity.id, include, maxDeep);
    } else if ((entityObject as IEntity).id) {
      return this.getFullObjectByIdWithIncludes((entityObject as IEntity).id, include, maxDeep);
    } else {
      console.warn("Fetching object without id", entityObject);
      return undefined;
    }
  }

  /**
   *
   * @param id the id of the object we want to fetch
   * @returns the fetched object
   */
  async fetchById(id: string, includes?: string[]): Promise<T> {
    let query = new Parse.Query(this.classname);
    if (includes) {
      includes.forEach(include => {
        query = query.include(include);
      });
    }
    let res$ = await query.get(id).then((res) => {
      return res;
    },
      (err) => {
        console.error("Cannot fetch object", err);
        return undefined;
      });
    if (!res$) throw new Error("Error: Object not found.");
    let returnValue: T = new this.classType();
    returnValue = { ... await this.mapParseAttributesToEntityObject(res$) as T };
    return returnValue as T;
  }

  /**
   * ### Use Case
   * Since working with typescripts' deep copy would simply copy the object itself,
   * whenever i need a duplicated object on the db too this function must be called.
   * #### Use Case Example
   * For example, let's save i have ```Obj1: EntityObject``` istance and i want a ```Obj2: EntityObject``` istance that is
   * exactly identical to ```Obj1```, but that i can change independently so that any change made to ```Obj2``` won't
   * affect ```Obj1```.
   *
   * If i did something like:
   * ```
   * let Obj2: EntityObject = {...Obj1};
   * ```
   * i'd copy the full ```Obj1``` into ```Obj2```, also the ```entity: IEntity``` attribute.
   *
   * But since ```entity``` is used by the data service for tracking what object the istance is related to
   * on the db, calling ```dataService.save(Obj2);``` would make dataservice work with the exact same entity
   * as ```Obj1``` thus affecting also ```Obj1```. In this scenario, you make think of ```Obj1``` and ```Obj2``` as 2 pointers
   * to the same db record.
   *
   * If i want to ```Obj2``` to be a completely new and indipendent, object we need it to omit the ```entity``` field during
   * the copy. Since the programmer should not care about this detail when working with this architecture,
   * he can simply do the following call:
   * ```
   * let Obj2: EntityObject = dataService.duplicate(Obj1);
   * ```
   * Now ```Obj2``` is a new object missing entity attribute, which will be assigned after the first ```dataService.save(Obj2)``` call like
   * if we just did a ```new EntityObject();``` call.
   * @param entityObject (param entityObject) the EntityObject to duplicate
   * @returns the new duplicated object, missing the entity field.
   */
  public async duplicate(entityObject: T, duplicateAttributes: boolean = false, toKeep: string[] = []): Promise<T> {
    if (!duplicateAttributes) {
      let newEntityObject = new this.classType();
      newEntityObject = { ...entityObject };
      delete (newEntityObject as any).entity;
      return newEntityObject;
    }
    const entity: keyof EntityObject = 'entity';
    let parseObject = this.getNewEntity();

    let property: keyof typeof entityObject;
    for (property in entityObject) {
      if (property == entity) {
        continue;
      }
      // check if property is among tokeep
      if (entityObject[property] && toKeep.length > 0 && toKeep.includes(property)) {
        parseObject.set(property, entityObject[property]);
      }
      if (entityObject[property] && (toKeep.length == 0 || !toKeep.includes(property))) {
        if (Array.isArray(entityObject[property])) {
          let arr = [];
          for (let obj of (entityObject[property] as unknown as any[])) {
            if (obj.entity && obj.entity.id) {
              let newParseObj = (obj.entity as Parse.Object).clone();
              arr.push(newParseObj);
            } else {
              arr.push(obj);
            }
          }
          parseObject.set(property, arr);
        } else {
          if ((entityObject[property] as any).entity && (entityObject[property] as any).entity.id) {
            let newParseObj = ((entityObject[property] as any).entity as Parse.Object).clone();
            parseObject.set(property, newParseObj);
          } else {
            parseObject.set(property, entityObject[property]);
          }
        }
      }
    }

    parseObject = await parseObject.save();
    return this.mapParseAttributesToEntityObject(parseObject);
  }

  async setACLByActiveUser(entityObject: T): Promise<T> {
    let user = Parse.User.current();
    (entityObject.entity as Parse.Object).setACL(new Parse.ACL(user));
    const entity = await (entityObject.entity as Parse.Object).save().then((res) => {
      return res;
    },
      (err) => {
        console.error("Cannot set ACL", err);
        return undefined;
      });
    if (!entity) throw new Error("Error: Object not found.");
    entityObject.entity = entity;
    return entityObject;
  }

  setACLByRole(role: string): Promise<T> {
    throw new Error("Method not implemented.");
  }

  async saveMany(entityObjects: T[], returnMappingDeepness = 2, batchSize = 150) {
    console.log("Inizio mapping");
    let entities = entityObjects.map((x) => {
      // let m = this.mappings(x);
      // try {
      //   if (x.entity && x.entity.id) {
      //     m['id'] = x.entity.id;
      //     (x.entity as Parse.Object).set(m);
      //   } else {
      //     x.entity = new Parse.Object(this.classname, m);
      //   }
      // } catch (err) {

      // }
      // return x.entity as Parse.Object;
      return this.mappings(x);
    });

    console.log("Fine mapping");
    console.log("Inizio salvataggio");
    let savedEntities: Parse.Object[] = await Parse.Object.saveAll(entities, { batchSize: batchSize }).then((res) => {
      return res;
    },
      (err) => {
        console.error("Cannot save object", err);
        throw new Error("Cannot save objects");
      });
    console.log("Fine salvataggio");
    console.log("Inizio interpretazione risposta");
    let returnValue = savedEntities.map(x => this.mapParseAttributesToEntityObject(x, 0, returnMappingDeepness));
    console.log("Termine interpretazione risposta");
    return returnValue;
  }

  async checkExistence(entityObject: T | IEntity): Promise<boolean> {
    let parseObject;
    if (entityObject instanceof EntityObject) {
      parseObject = (entityObject as EntityObject).entity as Parse.Object;
    } else {
      //check if it's istance of Parse.Object
      if (entityObject instanceof Parse.Object) {
        parseObject = entityObject as Parse.Object;
      } else {
        return false;
      }
    }
    return await parseObject.exists();
  }

}