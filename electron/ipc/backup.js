import Sqlite from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { dialog, ipcMain, app, shell } from 'electron'
import { dbPath, getDatabase, closeDatabase, reopenDatabase } from '../database.js'

const backupDirectory = path.join(app.getPath('userData'), 'Backups')
const restoreMarkerPath = path.join(backupDirectory, 'restore-in-progress.json')
const MAX_AUTOMATIC_BACKUPS = 3
const MAX_SAFETY_BACKUPS = 3

const REQUIRED_TABLES = [
    'categories',
    'items',
    'stock_transactions'
]

function ensureBackupDirectory() {
    fs.mkdirSync(backupDirectory, { recursive: true })
}

function removeDatabaseFiles(databasePath) {

    const files = [
        databasePath,
        `${databasePath}-wal`,
        `${databasePath}-shm`]

    for (const file of files) {

        try {
            if (fs.existsSync(file)) {
                fs.unlinkSync(file)
            }
        }
        catch (error) {
            console.error('FAILED TO DELETE DATABASE FILE:', file, error)
            throw error
        }
    }
}

function isPathInsideDirectory(filePath, directory) {

    const resolvedFile = path.resolve(filePath)
    const resolvedDirectory = path.resolve(directory)

    const relativePath = path.relative(resolvedDirectory, resolvedFile)
    return (
        relativePath !== '' &&
        !relativePath.startsWith('..' + path.sep) &&
        relativePath !== '..' &&
        !path.isAbsolute(relativePath))
}

function validateSQLiteDatabase(filePath) {

    let testDb = null
    try {
        if (!fs.existsSync(filePath)) {
            return {
                valid: false,
                message: 'Database file does not exist.'
            }
        }
        testDb = new Sqlite(filePath, { readonly: true })

        const tables = testDb
            .prepare(`
                SELECT name
                FROM sqlite_master
                WHERE type = 'table'
            `).all()

        const tableNames = tables.map(table => table.name)
        const missingTables = REQUIRED_TABLES
            .filter(table => !tableNames.includes(table))

        if (missingTables.length > 0) {
            return {
                valid: false,
                message:'This is not a valid Hospitrax database backup.'
            }
        }

        const integrity = testDb.prepare(`PRAGMA integrity_check`).get()
        if (integrity.integrity_check !== 'ok') {
            return {
                valid: false,
                message:'The selected database is corrupted.'
            }
        }

        const foreignKeyErrors = testDb.prepare(`PRAGMA foreign_key_check`).all()
        if (foreignKeyErrors.length > 0) {
            return {
                valid: false,
                message:'The selected database contains invalid foreign-key references.'
            }
        }

        const schemaVersion = testDb.pragma('user_version', { simple: true })

        if (!Number.isInteger(schemaVersion) || schemaVersion < 0 || schemaVersion > 2) {
            return {
                valid: false,
                message:'The database schema version is not supported.'
            }
        }

        return {
            valid: true,
            schemaVersion
        }
    }
    catch (error) {
        return {
            valid: false,
            message:`SQLite validation failed: ${error.message}`
        }
    }
    finally {
        if (testDb) {
            try {
                testDb.close()
            }
            catch (error) {
                console.error('FAILED TO CLOSE VALIDATION DATABASE:', error)
            }
        }
    }
}

function createRestoreMarker({ operation, safetyBackupPath, selectedBackupPath }) {

    try {
        ensureBackupDirectory()
        const marker = {
            operation,
            safetyBackupPath,
            selectedBackupPath,
            databasePath: dbPath,
            startedAt: Date.now(),
            state: 'prepared'
        }

        const tempMarkerPath = `${restoreMarkerPath}.tmp`
        fs.writeFileSync(tempMarkerPath, JSON.stringify(marker, null, 2), 'utf8')
        fs.renameSync(tempMarkerPath, restoreMarkerPath)

        return true
    }
    catch (error) {
        console.error('FAILED TO CREATE RESTORE TRANSACTION MARKER:', error)
        return false
    }
}


function updateRestoreMarkerState(state) {

    try {
        if (!fs.existsSync(restoreMarkerPath)) {
            console.error('RESTORE MARKER DOES NOT EXIST')
            return false
        }

        const marker = JSON.parse(fs.readFileSync(restoreMarkerPath, 'utf8'))
        marker.state = state
        const tempMarkerPath = `${restoreMarkerPath}.tmp`

        fs.writeFileSync(tempMarkerPath, JSON.stringify(marker, null, 2), 'utf8')
        fs.renameSync(tempMarkerPath, restoreMarkerPath)

        return true
    }
    catch (error) {
        console.error('FAILED TO UPDATE RESTORE MARKER STATE:', error)
        return false
    }
}

function removeRestoreMarker() {

    try {

        if (fs.existsSync(restoreMarkerPath)) {
            fs.unlinkSync(restoreMarkerPath)
        }
        return true
    }
    catch (error) {
        console.error('FAILED TO DELETE RESTORE MARKER:', error)
        return false
    }
}

function cleanupAutomaticBackups() {

    try {
        if (!fs.existsSync(backupDirectory)) {
            return
        }

        const backups =
            fs.readdirSync(backupDirectory)
                .filter(file =>/^automatic-backup-.*\.db$/.test(file))
                .map(file => { const filePath = path.join(backupDirectory, file)

        return {file,
                filePath,
                createdAt: fs.statSync(filePath).mtimeMs
        }}).sort((a, b) => b.createdAt - a.createdAt)


        const oldBackups = backups.slice(MAX_AUTOMATIC_BACKUPS)

        for (const backup of oldBackups) {
            try {
                removeDatabaseFiles(backup.filePath)
            }
            catch (error) {
                console.error('FAILED TO DELETE OLD AUTOMATIC BACKUP:', backup.filePath, error)
            }
        }
    }
    catch (error) {
        console.error('AUTOMATIC BACKUP CLEANUP ERROR:', error)
    }
}


function cleanupSafetyBackups() {

    try {
        if (!fs.existsSync(backupDirectory)) {
            return
        }

        const backups = fs.readdirSync(backupDirectory)
            .filter(file => /^safety-backup-before-(?:manual|automatic)-restore-\d+\.db$/
            .test(file))
            .map(file => {const filePath = path.join(backupDirectory,file)

        return {file,
                filePath,
                createdAt: fs.statSync(filePath).mtimeMs
        }}).sort((a, b) => b.createdAt - a.createdAt)


        const oldBackups = backups.slice(MAX_SAFETY_BACKUPS)

        for (const backup of oldBackups) {

            try {
                removeDatabaseFiles(backup.filePath)
            }
            catch (error) {
                console.error('FAILED TO DELETE OLD SAFETY BACKUP:', backup.filePath, error)
            }
        }
    }
    catch (error) {
        console.error('SAFETY BACKUP CLEANUP ERROR:', error)
    }
}

async function createSafetyBackup(operation) {

    ensureBackupDirectory()
    const safetyBackupPath = path.join(backupDirectory,`safety-backup-before-${operation}-restore-${Date.now()}.db`)
    const db = getDatabase()

    await db.backup(safetyBackupPath)
    const validation = validateSQLiteDatabase(safetyBackupPath)

    if (!validation.valid) {
        console.error('SAFETY BACKUP VALIDATION FAILED:', validation.message)
        try {
            removeDatabaseFiles(safetyBackupPath)
        }
        catch (cleanupError) {
            console.error('FAILED TO REMOVE INVALID SAFETY BACKUP:', cleanupError)
        }
        throw new Error('Unable to create a valid safety backup.')
    }
    cleanupSafetyBackups()
    return safetyBackupPath
}


function rollbackDatabase(safetyBackupPath) {

    try {

        closeDatabase()
        removeDatabaseFiles(dbPath)

        fs.copyFileSync(safetyBackupPath, dbPath)

        const validation = validateSQLiteDatabase(dbPath)

        if (!validation.valid) {
            throw new Error(`Rollback database failed validation: ${validation.message}`)
        }

        reopenDatabase()
        console.log('DATABASE ROLLBACK SUCCESSFUL')
        return true
    }
    catch (error) {
        console.error('DATABASE ROLLBACK FAILED:', error)
        return false
    }
}

async function restoreDatabase({ selectedPath, operation }) {

    let safetyBackupPath = null
    let restoreCompleted = false

    try {

        const validation = validateSQLiteDatabase(selectedPath)
        if (!validation.valid) {
            return {
                success: false,
                message: validation.message
            }
        }

        safetyBackupPath = await createSafetyBackup(operation)

        const markerCreated = createRestoreMarker({
            operation: `${operation}-restore`, safetyBackupPath,
            selectedBackupPath: selectedPath})

        if (!markerCreated) {
            throw new Error('Unable to prepare restore transaction.')
        }

        closeDatabase()
        removeDatabaseFiles(dbPath)
        fs.copyFileSync(selectedPath, dbPath)
        reopenDatabase()

        const restoredValidation = validateSQLiteDatabase(dbPath)

        if (!restoredValidation.valid) {
            throw new Error(`Restored database failed validation: ${restoredValidation.message}`)
        }

        const stateUpdated = updateRestoreMarkerState('restored')
        if (!stateUpdated) {
            throw new Error('Restored database is valid, but failed to update restore transaction state.')
        }

        restoreCompleted = true

        const markerRemoved = removeRestoreMarker()

        if (!markerRemoved) {
            throw new Error('Restored database is valid, but failed to remove restore transaction marker.')
        }

        return {
            success: true
        }
    }
    catch (error) {
        console.error(`${operation.toUpperCase()} DATABASE RESTORE ERROR:`, error)

        if (!restoreCompleted && safetyBackupPath && fs.existsSync(safetyBackupPath)) {
            const rollbackSuccessful = rollbackDatabase(safetyBackupPath)

            if (rollbackSuccessful) {
                removeRestoreMarker()

                return {
                    success: false,
                    message:'Database restore failed. Your previous database has been recovered.'
                }
            }
        }

        try {
            if (fs.existsSync(dbPath)) {

                const validation = validateSQLiteDatabase(dbPath)
                if (validation.valid) {
                    reopenDatabase()
                }
            }
        }
        catch (reopenError) {
            console.error('DATABASE REOPEN ERROR:', reopenError)
        }
        return {
            success: false,
            message:'Database restore failed and automatic recovery was unsuccessful.'
        }
    }
}

async function recoverInterruptedRestore() {

    try {
        if (!fs.existsSync(restoreMarkerPath)) {
            return {
                success: true,
                recovered: false
            }
        }
        const marker = JSON.parse(fs.readFileSync(restoreMarkerPath, 'utf8'))
        const safetyBackupPath = marker.safetyBackupPath

        if (!safetyBackupPath) {
            throw new Error('Restore marker does not contain a safety backup path.')
        }

        if (!fs.existsSync(safetyBackupPath)) {
            throw new Error(`Safety backup does not exist: ${safetyBackupPath}`)
        }

        const safetyValidation = validateSQLiteDatabase(safetyBackupPath)

        if (!safetyValidation.valid) {
            throw new Error(`Safety backup is invalid: ${safetyValidation.message}`)
        }
        console.log('SAFETY BACKUP VALIDATED:', safetyBackupPath)

        if (marker.state === 'restored') {
            const currentValidation = validateSQLiteDatabase(dbPath)

            if (currentValidation.valid) {
                console.log('CURRENT RESTORED DATABASE VALIDATED SUCCESSFULLY')
                removeRestoreMarker()

                return {
                    success: true,
                    recovered: true
                }
            }
            console.log('RESTORED DATABASE IS INVALID. ROLLING BACK.')
        }

        console.log('RESTORE WAS NOT COMPLETED. ROLLING BACK.')

        closeDatabase()

        removeDatabaseFiles(dbPath)

        fs.copyFileSync(safetyBackupPath, dbPath)
        console.log('SAFETY BACKUP AUTOMATICALLY RESTORED:', safetyBackupPath)

        const recoveredValidation = validateSQLiteDatabase(dbPath)
        if (!recoveredValidation.valid) {
            throw new Error(`Recovered database is invalid: ${recoveredValidation.message}`)
        }

        reopenDatabase()
        removeRestoreMarker()
        return {
            success: true,
            recovered: true
        }
    }
    catch (error) {
        console.error('AUTOMATIC RESTORE RECOVERY FAILED:', error)
        return {
            success: false,
            recovered: false,
            message: error.message
        }
    }
}

function registerBackupHandlers() {

    ipcMain.handle('database:backup', async () => {
        try {
            getDatabase()

            const now = new Date()

            const date = 
                `${now.getFullYear()}-` 
                +`${String(now.getMonth() + 1).padStart(2, '0')}-` 
                +`${String(now.getDate()).padStart(2, '0')}`

            const result = await dialog.showSaveDialog({
                title:'Backup Hospitrax Database',
                defaultPath:`inventory-backup-${date}.db`,
                filters: [{ name:'SQLite Database',
                            extensions: ['db']}]
            })

            if (result.canceled || !result.filePath) {
                return {
                    success: false,
                    canceled: true
                }
            }
            const db = getDatabase()

            await db.backup(result.filePath)
            const validation = validateSQLiteDatabase(result.filePath)

            if (!validation.valid) {
                try {
                    removeDatabaseFiles(result.filePath)
                }
                catch (cleanupError) {
                    console.error('FAILED TO DELETE INVALID MANUAL BACKUP:',cleanupError)
                }
                return {
                    success: false,
                    message:`Backup validation failed: ${validation.message}`
                    }
            }

            return {
                    success: true,
                    path: result.filePath
                }
            }
            catch (error) {
                console.error('DATABASE BACKUP ERROR:', error)
                return {
                    success: false,
                    message:'Database backup failed.'
                }
            }
        }
    )

    ipcMain.handle('database:openBackupFolder', async () => {
        try {
            ensureBackupDirectory()

            const error = await shell.openPath(backupDirectory)

            if (error) {
                console.error('OPEN BACKUP FOLDER ERROR:', error)
                return {
                    success: false,
                    message:'Unable to open backup folder.'
                }
            }

            return {
                success: true
            }
        }
        catch (error) {
            console.error('OPEN BACKUP FOLDER ERROR:', error)
            return {
                success: false,
                message:'Unable to open backup folder.'
            }
        }
    })


    ipcMain.handle('database:getAutomaticBackups', async () => {
        try {
            ensureBackupDirectory()

            const backups = fs.readdirSync(backupDirectory)
            .filter(file => /^automatic-backup-.*\.db$/.test(file))
            .map(file => {const filePath = path.join(backupDirectory,file)

                const stats = fs.statSync(filePath)
                return {
                    file,
                    path: filePath,
                    createdAt:stats.mtimeMs
                }
            }).sort((a, b) => b.createdAt - a.createdAt)

            return {
                success: true,
                backups
            }

        }
        catch (error) {
            console.error('AUTOMATIC BACKUP LIST ERROR:', error)
            return {
                success: false,
                message:'Unable to load automatic backups.'
            }
        }
    })

    ipcMain.handle('database:getAutomaticBackupStatus', async () => {
        try {

            if (!fs.existsSync(backupDirectory)) {
                return {
                    success: true,
                    exists: false
                }
            }

            const backups = fs.readdirSync(backupDirectory)
                .filter(file =>/^automatic-backup-.*\.db$/.test(file))
                .map(file => {const filePath = path.join(backupDirectory, file)
                    const stats = fs.statSync(filePath)

                    return {
                        file,
                        filePath,
                        createdAt:stats.mtimeMs
                    }
                }).sort((a, b) => b.createdAt - a.createdAt)

            if (backups.length === 0) {
                return {
                    success: true,
                    exists: false
                }
            }

            const latestBackup = backups[0]

            return {
                success: true,
                exists: true,
                file: latestBackup.file,
                createdAt:latestBackup.createdAt
            }

        }
        catch (error) {
            console.error('AUTOMATIC BACKUP STATUS ERROR:', error)
            return {
                success: false,
                exists: false,
                message: 'Unable to check automatic backup status.'
            }
        }
    })

    ipcMain.handle('database:restore', async () => {
        try {
            const result = await dialog.showOpenDialog({
                title: 'Restore Hospitrax Database',
                properties: ['openFile'],
                filters: [{ name: 'SQLite Database',
                            extensions: ['db']}]
            })

            if (result.canceled || result.filePaths.length === 0) {
                return {
                    success: false,
                    canceled: true
                }
            }

            const selectedPath = result.filePaths[0]
            if (path.resolve(selectedPath) === path.resolve(dbPath)) {
                return {
                    success: false,
                    message:'You cannot restore the currently active database.'
                }
            }
            return await restoreDatabase({
                selectedPath,
                operation: 'manual'
            })
        }
        catch (error) {
            console.error('MANUAL RESTORE IPC ERROR:', error)
            return {
                success: false,
                message:'Database restore failed.'
                }
        }
    })

    ipcMain.handle('database:restoreAutomatic', async (_, selectedPath) => {
        try {
            if (!selectedPath) {
                return {
                    success: false,
                    message:'No automatic backup selected.'
                }
            }

            const resolvedPath = path.resolve(selectedPath)

            if (!isPathInsideDirectory(resolvedPath, backupDirectory)) {
                return {
                    success: false,
                    message:'Invalid automatic backup location.'
                }
            }
        
            const fileName = path.basename(resolvedPath)

            if (!/^automatic-backup-.*\.db$/.test(fileName)) {
                return {
                    success: false,
                    message:'Invalid automatic backup file.'
                }
            }

            if (!fs.existsSync(resolvedPath)) {
                return {
                    success: false,
                    message:'The selected automatic backup no longer exists.'
                }
            }
            if (resolvedPath === path.resolve(dbPath)) {
                return {
                    success: false,
                    message:'You cannot restore the currently active database.'
                }
            }

            return await restoreDatabase({
                selectedPath:resolvedPath,
                operation:'automatic'
            })
        }
        catch (error) {
                console.error('AUTOMATIC RESTORE IPC ERROR:', error)
                return {
                    success: false,
                    message:'Automatic backup restore failed.'
                }
        }
    })
}

async function createAutomaticBackup() {

    try {
        const db = getDatabase()

        ensureBackupDirectory()

        const now = new Date()
        const timestamp = now.toLocaleString('en-US', {
            timeZone: 'Asia/Manila',
            year: 'numeric',
            month:'short',
            day: '2-digit',
            hour: 'numeric',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        })  .replace(/:/g, '-')
            .replace(/\//g,'-')
            .replace(/,/g, '')


        const backupPath = path.join(backupDirectory, `automatic-backup-${timestamp}.db`)

        await db.backup(backupPath)
        const validation = validateSQLiteDatabase(backupPath)

        if (!validation.valid) {
            try {
                removeDatabaseFiles(backupPath)
            }
            catch (cleanupError) {
                console.error('FAILED TO DELETE INVALID AUTOMATIC BACKUP:', cleanupError)
            }
            throw new Error(`Automatic backup validation failed: ${validation.message}`)
        }

        console.log('AUTOMATIC BACKUP CREATED:', backupPath)
        cleanupAutomaticBackups()

        return {
            success: true,
            path:backupPath
        }
    }
    catch (error) {
        console.error('AUTOMATIC DATABASE BACKUP ERROR:', error)
        return {
            success: false,
            message: 'Automatic database backup failed.'
        }
    }
}

export {
    registerBackupHandlers,
    createAutomaticBackup,
    recoverInterruptedRestore}