import { app, BrowserWindow, dialog, shell } from 'electron'
import path from 'node:path'
import { isDev } from './util.js'
import { getPreloadPath, getUIPath } from './pathResolver.js'
import { openDatabase, closeDatabase } from './database.js'

import { registerCategoryHandlers } from './ipc/categories.js'
import { registerItemsHandlers } from './ipc/items.js'
import { stockTransactionsHandlers } from './ipc/stockTransactions.js'
import { registerBackupHandlers, createAutomaticBackup, recoverInterruptedRestore } from './ipc/backup.js'


app.on('before-quit', () => {
    console.log('HOSPITRAX IS SHUTTING DOWN')
    closeDatabase()
})

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit()
    }
})

app.whenReady().then(async () => {
    try {
        const recoveryResult = await recoverInterruptedRestore()
        if (recoveryResult?.success === false) {
            dialog.showErrorBox('Hospitrax Database Recovery Failed',
                                'Hospitrax could not safely recover the database after an interrupted restore.\n\n' +
                                'The application will close to prevent further database changes.')
            app.quit()
            return
        }

        openDatabase()
        registerCategoryHandlers()
        registerItemsHandlers()
        stockTransactionsHandlers()
        registerBackupHandlers()
        await createAutomaticBackup()

        const mainWindow = new BrowserWindow({
            width: 1280,
            height: 800,
            minWidth: 1000,
            minHeight: 650,
            title: 'Hospitrax',

            icon: path.join(
                app.getAppPath(),
                'assets',
                'icon.ico'),

            webPreferences: {
                preload: getPreloadPath(),
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true
            }
        })


        mainWindow.webContents.setWindowOpenHandler(({ url }) => {

            if (url.startsWith('https://')) {
                shell.openExternal(url)
            }

            return {
                action: 'deny'
            }
        })

        mainWindow.webContents.on('will-navigate', (event, url) => {
            const allowed = isDev()
                ? url.startsWith('http://localhost:5000')
                : url.startsWith('file://')

            if (allowed) {
                return
            }

            event.preventDefault()

            if (url.startsWith('https://')) {
                shell.openExternal(url)
            }
        })

        if (isDev()) {
            mainWindow.loadURL('http://localhost:5000')
        }
        else {
            mainWindow.loadFile(getUIPath())
        }
    }
    catch (error) {
        dialog.showErrorBox('Hospitrax Startup Error',
                            'Hospitrax could not start safely.\n\n' +
                            `${error.message}`)
        app.quit()
    }
})