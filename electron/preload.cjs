const { contextBridge, ipcRenderer } = require('electron')

function invoke(channel, ...args) {
    return ipcRenderer.invoke(channel, ...args)
}

contextBridge.exposeInMainWorld('electron', {
    categories: {
        getAll: () =>
            invoke('categories:getAll'),
        create: (categoryName) =>
            invoke('categories:create', categoryName),
        get: (id) =>
            invoke('categories:get', id),
        update: (id, category_name) =>
            invoke('categories:update', {
                id,
                category_name
            }),
        delete: (id) =>
            invoke('categories:delete', id)
    },
    items: {
        getAll: () =>
            invoke('items:getAll'),
        get: (id) =>
            invoke('items:get', id),
        create: (data) =>
            invoke('items:create', data),
        update: (id, data) =>
            invoke('items:update', {id,...data}),
        delete: (id) =>
            invoke('items:delete', id)
    },

    stockTransactions: {
        getAll: () =>
            invoke('stockTransactions:getAll'),
        get: (id) =>
            invoke('stockTransactions:get', id)
    },
    database: {
        backup: () =>
            invoke('database:backup'),
        restore: () =>
            invoke('database:restore'),
        openBackupFolder: () =>
            invoke('database:openBackupFolder'),
        getAutomaticBackupStatus: () =>
            invoke('database:getAutomaticBackupStatus'),
        getAutomaticBackups: () =>
            invoke('database:getAutomaticBackups'),
        restoreAutomatic: (filePath) =>
            invoke('database:restoreAutomatic', filePath)
    }
})