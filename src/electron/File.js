/*
 *
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 *
 */
'use strict';

//Base Work done by zorn-v - https://github.com/zorn-v/cordova-plugin-file/blob/electron/src/electron/FileProxy.js for electron compatibility using Node.js fs.
//This version removes rimraf for recursive delete using native fs.rm with Node 14+ with recursive and force options.

const nodePath = require('path');
const fs = require('fs');
const promisify = require('util').promisify;
const app = require('electron').app;

const { FileEntry, FileError, JSFile, DirectoryEntry } = require('./Types');

// https://github.com/electron/electron/blob/master/docs/api/app.md#appgetpathname
const pathsPrefix = {
    applicationDirectory: nodePath.dirname(app.getAppPath()) + nodePath.sep,
    dataDirectory: app.getPath('userData') + nodePath.sep,
    externalDataDirectory: app.getPath('userData') + nodePath.sep,
    cacheDirectory: app.getPath('cache') + nodePath.sep,
    tempDirectory: app.getPath('temp') + nodePath.sep,
    documentsDirectory: app.getPath('documents') + nodePath.sep
};

//Fix Cordova Electron 3.0 Args Bug. Electron context bridge uses ... for receiving args. This causes
//args to be nested in another array when sent, this is not like other platform args and makes plugin compatibility hard. 
// This may change in future so we'll handle it here.
function getArgs(args) {
    if(Array.isArray(args) && args.length === 1 && Array.isArray(args[0])) {
        return args[0];
    }
    else {
        return args;
    }
}

/** * Exported functionality ***/

// list a directory's contents (files and folders).
exports.readEntries = function (args) {
    args = getArgs(args);
    const fullPath = args[0];

    return new Promise(function (resolve, reject) {
        fs.readdir(fullPath, {withFileTypes: true}, (err, files) => {
            if (err) {
                reject(FileError.NOT_FOUND_ERR);
                return;
            }
            const result = [];
            files.forEach(d => {
                let path = fullPath + d.name;
                if (d.isDirectory()) {
                    path += nodePath.sep;
                }
                result.push({
                    isDirectory: d.isDirectory(),
                    isFile: d.isFile(),
                    name: d.name,
                    fullPath: path,
                    filesystemName: 'temporary',
                    nativeURL: path
                });
            });
            resolve(result);
        });
    });
};

exports.getFile = function (args) {
    args = getArgs(args);
    const path = args[0] + args[1];
    const options = args[2] || {};

    return new Promise(function (resolve, reject) {
        fs.stat(path, (err, stats) => {
            if (err && err.code !== 'ENOENT') {
                reject(FileError.INVALID_STATE_ERR);
                return;
            }
            const exists = !err;
            const baseName = require('path').basename(path);
    
            function createFile () {
                fs.open(path, 'w', (err, fd) => {
                    if (err) {
                        reject(FileError.INVALID_STATE_ERR);
                        return;
                    }
                    fs.close(fd, (err) => {
                        if (err) {
                            reject(FileError.INVALID_STATE_ERR);
                            return;
                        }
                        resolve(new FileEntry(baseName, path));
                    });
                });
            }
    
            if (options.create === true && options.exclusive === true && exists) {
                // If create and exclusive are both true, and the path already exists,
                // getFile must fail.
                reject(FileError.PATH_EXISTS_ERR);
            } else if (options.create === true && !exists) {
                // If create is true, the path doesn't exist, and no other error occurs,
                // getFile must create it as a zero-length file and return a corresponding
                // FileEntry.
                createFile();
            } else if (options.create === true && exists) {
                if (stats.isFile()) {
                    // Overwrite file, delete then create new.
                    createFile();
                } else {
                    reject(FileError.INVALID_MODIFICATION_ERR);
                }
            } else if (!options.create && !exists) {
                // If create is not true and the path doesn't exist, getFile must fail.
                reject(FileError.NOT_FOUND_ERR);
            } else if (!options.create && exists && stats.isDirectory()) {
                // If create is not true and the path exists, but is a directory, getFile
                // must fail.
                reject(FileError.TYPE_MISMATCH_ERR);
            } else {
                // Otherwise, if no other error occurs, getFile must return a FileEntry
                // corresponding to path.
                resolve(new FileEntry(baseName, path));
            }
        });
    });
};

exports.getFileMetadata = function (args) {
    args = getArgs(args);
    const fullPath = args[0];

    return new Promise(function (resolve, reject) {
        fs.stat(fullPath, (err, stats) => {
            if (err) {
                reject(FileError.NOT_FOUND_ERR);
                return;
            }
            const baseName = require('path').basename(fullPath);
            resolve(new JSFile(baseName, fullPath, '', stats.mtime, stats.size));
        });
    });
};

exports.getMetadata = function (args) {
    return new Promise(function (resolve, reject) {
        fs.stat(args[0], (err, stats) => {
            if (err) {
                reject(FileError.NOT_FOUND_ERR);
                return;
            }
            resolve({
                modificationTime: stats.mtime,
                size: stats.size
            });
        });
    });
};

exports.setMetadata = function (args) {
    args = getArgs(args);
    const fullPath = args[0];
    const metadataObject = args[1];
    return new Promise(function (resolve, reject) {
        fs.utimes(fullPath, metadataObject.modificationTime, metadataObject.modificationTime, (err) => {
            if (err) {
                reject(FileError.NOT_FOUND_ERR);
                return;
            }
            resolve();
        });
    });
};

exports.write = function (args) {
    args = getArgs(args);
    const fileName = args[0];
    const data = args[1];
    const position = args[2];

    if (!data) {
        return Promise.reject(FileError.INVALID_MODIFICATION_ERR);
    }

    const buf = Buffer.from(data);
    let bytesWritten = 0;
    return promisify(fs.open)(fileName, 'a')
        .then(fd => {
            return promisify(fs.write)(fd, buf, 0, buf.length, position)
                        .then(bw => { bytesWritten = bw; })
                        .finally(() => promisify(fs.close)(fd));
        })
        .then(() => bytesWritten);
};

exports.readAsText = function (args) {
    args = getArgs(args);
    const fileName = args[0];
    const enc = args[1];
    const startPos = args[2];
    const endPos = args[3];

    return readAs('text', fileName, enc, startPos, endPos);
};

exports.readAsDataURL = function (args) {
    args = getArgs(args);
    const fileName = args[0];
    const startPos = args[1];
    const endPos = args[2];

    return readAs('dataURL', fileName, null, startPos, endPos);
};

exports.readAsBinaryString = function (args) {
    args = getArgs(args);
    const fileName = args[0];
    const startPos = args[1];
    const endPos = args[2];

    return readAs('binaryString', fileName, null, startPos, endPos);
};

exports.readAsArrayBuffer = function (args) {
    args = getArgs(args);
    const fileName = args[0];
    const startPos = args[1];
    const endPos = args[2];

    return readAs('arrayBuffer', fileName, null, startPos, endPos);
};

exports.remove = function (args) {
    args = getArgs(args);
    const fullPath = args[0];

    return new Promise(function (resolve, reject) {
        fs.stat(fullPath, (err, stats) => {
            if (err) {
                reject(FileError.NOT_FOUND_ERR);
                return;
            }
            const rm = stats.isDirectory() ? fs.rmdir : fs.unlink;
            rm(fullPath, (err) => {
                if (err) {
                    reject(FileError.NO_MODIFICATION_ALLOWED_ERR);
                    return;
                }
                resolve();
            });
        });
    });
};

exports.truncate = function (args) {
    args = getArgs(args);
    const fullPath = args[0];
    const size = args[1];

    return new Promise(function (resolve, reject) {
        fs.truncate(fullPath, size, err => {
            if (err) {
                reject(FileError.INVALID_STATE_ERR);
                return;
            }
            resolve(size);
        });
    });
};

exports.removeRecursively = function (args) {
    args = getArgs(args);
    const fullPath = args[0];

    return new Promise(function (resolve, reject) {
        fs.stat(fullPath, (err, stats) => {
            if (err) {
                reject(FileError.NOT_FOUND_ERR);
                return;
            }
            const rm = stats.isDirectory() ? fs.rmdir : fs.unlink;
            rm(fullPath, (err) => {
                if (err) {
                    reject(FileError.NO_MODIFICATION_ALLOWED_ERR);
                    return;
                }
                resolve();
            },  { recursive: true, force: true });
        });
    });
};

exports.getDirectory = function (args) {
    args = getArgs(args);
    const path = args[0] + args[1];
    const options = args[2] || {};

    return new Promise(function (resolve, reject) {
        fs.stat(path, (err, stats) => {
            if (err && err.code !== 'ENOENT') {
                reject(FileError.INVALID_STATE_ERR);
                return;
            }

            const exists = !err;
            const baseName = require('path').basename(path);

            if (options.create === true && options.exclusive === true && exists) {
                // If create and exclusive are both true, and the path already exists,
                // getDirectory must fail.
                reject(FileError.PATH_EXISTS_ERR);
            } else if (options.create === true && !exists) {
                // If create is true, the path doesn't exist, and no other error occurs,
                // getDirectory must create it as a zero-length file and return a corresponding
                // MyDirectoryEntry.
                fs.mkdir(path, (err) => {
                    if (err) {
                        reject(FileError.PATH_EXISTS_ERR);
                        return;
                    }
                    resolve(new DirectoryEntry(baseName, path));
                });
            } else if (options.create === true && exists) {
                if (stats.isDirectory()) {
                    resolve(new DirectoryEntry(baseName, path));
                } else {
                    reject(FileError.INVALID_MODIFICATION_ERR);
                }
            } else if (!options.create && !exists) {
                // If create is not true and the path doesn't exist, getDirectory must fail.
                reject(FileError.NOT_FOUND_ERR);
            } else if (!options.create && exists && stats.isFile()) {
                // If create is not true and the path exists, but is a file, getDirectory
                // must fail.
                reject(FileError.TYPE_MISMATCH_ERR);
            } else {
                // Otherwise, if no other error occurs, getDirectory must return a
                // DirectoryEntry corresponding to path.
                resolve(new DirectoryEntry(baseName, path));
            }
        });
    });
};

exports.getParent = function (args) {
    args = getArgs(args);
    const parentPath = nodePath.dirname(args[0]);
    const parentName = nodePath.basename(parentPath);
    const path = nodePath.dirname(parentPath) + nodePath.sep;

    return exports.getDirectory([path, parentName, {create: false}]);
};

exports.copyTo = function (args) {
    args = getArgs(args);
    const srcPath = args[0];
    const dstDir = args[1];
    const dstName = args[2];

    return new Promise(function (resolve, reject) {
        fs.copyFile(srcPath, dstDir + dstName, (err) => {
            if (err) {
                reject(FileError.INVALID_MODIFICATION_ERR);
                return;
            }
            exports.getFile([dstDir, dstName]).then(resolve).catch(reject);
        });
    });
};

exports.moveTo = function (args) {
    args = getArgs(args);
    const srcPath = args[0];
    
    return exports.copyTo(args).then(function (fileEntry) {
        return exports.remove([srcPath]).then(function() {
            return fileEntry;
        });
    });
};

exports.resolveLocalFileSystemURI = function (args) {
    args = getArgs(args);
    let path = args[0];

    // support for encodeURI
    if (/\%5/g.test(path) || /\%20/g.test(path)) {  // eslint-disable-line no-useless-escape
        path = decodeURI(path);
    }

    // support for cdvfile
    if (path.trim().substr(0, 7) === 'cdvfile') {
        if (path.indexOf('cdvfile://localhost') === -1) {
            Promise.reject(FileError.ENCODING_ERR);
            return;
        }

        const indexApplication = path.indexOf('application');
        const indexPersistent = path.indexOf('persistent');
        const indexTemporary = path.indexOf('temporary');

        if (indexApplication !== -1) { // cdvfile://localhost/application/path/to/file
            path = pathsPrefix.applicationDirectory + path.substr(indexApplication + 12);
        } else if (indexPersistent !== -1) { // cdvfile://localhost/persistent/path/to/file
            path = pathsPrefix.dataDirectory + path.substr(indexPersistent + 11);
        } else if (indexTemporary !== -1) { // cdvfile://localhost/temporary/path/to/file
            path = pathsPrefix.tempDirectory + path.substr(indexTemporary + 10);
        } else {
            return Promise.reject(FileError.ENCODING_ERR);
        }
    }

    return new Promise(function(resolve, reject) {
        fs.stat(path, (err, stats) => {
            if (err) {
                reject(FileError.NOT_FOUND_ERR);
                return;
            }
    
            const baseName = require('path').basename(path);
            if (stats.isDirectory()) {
                resolve(new DirectoryEntry(baseName, path));
            } else {
                resolve(new FileEntry(baseName, path));
            }
        });
    });
    
};

exports.requestAllPaths = function() {
    return Promise.resolve(pathsPrefix);
};

/** * Helpers ***/
function readAs (what, fullPath, encoding, startPos, endPos) {
    return new Promise(function (resolve, reject) {
        fs.open(fullPath, 'r', (err, fd) => {
            if (err) {
                reject(FileError.NOT_FOUND_ERR);
                return;
            }
            const buf = Buffer.alloc(endPos - startPos);
            promisify(fs.read)(fd, buf, 0, buf.length, startPos)
                .then(() => {
                    switch (what) {
                    case 'text':
                        resolve(buf.toString(encoding));
                        break;
                    case 'dataURL':
                        resolve('data:;base64,' + buf.toString('base64'));
                        break;
                    case 'arrayBuffer':
                        resolve(buf);
                        break;
                    case 'binaryString':
                        resolve(buf.toString('binary'));
                        break;
                    }
                })
                .catch(() => {
                    reject(FileError.NOT_READABLE_ERR);
                })
                .then(() => promisify(fs.close)(fd));
        });
    });
}
