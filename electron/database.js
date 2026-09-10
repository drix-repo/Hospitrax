import Sqlite from 'better-sqlite3'
import { app } from 'electron'
import path from 'node:path'

const dbPath = path.join(app.getPath('userData'), 'items.db')
const CURRENT_SCHEMA_VERSION = 2
let db = null

const DEFAULT_CATEGORIES = [
    'Medical Supplies',
    'PPE',
    'Medicines',
    'Laboratory Supplies',
    'Disinfectants & Cleaning',
    'Surgical Supplies',
    'Emergency Supplies',
    'Wound Care',
    'IV & Infusion Supplies',
    'Respiratory Supplies',
    'Dental Supplies',
    'Diagnostic Supplies',
    'Medical Equipment',
    'Hospital Furniture',
    'Linens & Patient Clothing',
    'Office Supplies',
    'Food & Dietary Supplies',
    'Waste Management',
    'Electrical & Technical Supplies',
    'General Supplies'
]


function getSchemaVersion() {
    return db.pragma('user_version', { simple: true })
}


function setSchemaVersion(version) {

    if (!Number.isInteger(version) || version < 0) {
        throw new Error(`Invalid database schema version: ${version}`)
    }

    db.pragma(`user_version = ${version}`)
}

function hasInitialSchema() {

    const requiredTables = [
        'categories',
        'items',
        'stock_transactions'
    ]

    const tables = 
        db.prepare(`SELECT name
                    FROM sqlite_master
                    WHERE type = 'table'
    `).all()

    const tableNames = tables.map(table => table.name)
    return requiredTables.every(table => tableNames.includes(table))
}

function createTables() {

    const createTablesTransaction = db.transaction(() => {
            db.prepare(`CREATE TABLE IF NOT EXISTS categories (
                        category_id INTEGER PRIMARY KEY AUTOINCREMENT,
                        category_name TEXT NOT NULL UNIQUE)
            `).run()

            db.prepare(`CREATE TABLE IF NOT EXISTS items (
                        items_id INTEGER PRIMARY KEY AUTOINCREMENT,
                        items_name TEXT NOT NULL UNIQUE,
                        category_id INTEGER,
                        quantity REAL NOT NULL DEFAULT 0,
                        unit TEXT NOT NULL,
                        unit_cost REAL NOT NULL DEFAULT 0,
                        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

                        FOREIGN KEY (category_id) REFERENCES categories(category_id))
            `).run()

            db.prepare(`CREATE TABLE IF NOT EXISTS stock_transactions (
                        transaction_id INTEGER PRIMARY KEY AUTOINCREMENT,
                        items_id INTEGER NOT NULL,
                        transaction_type TEXT NOT NULL,
                        quantity REAL NOT NULL,
                        unit TEXT NOT NULL,
                        unit_cost REAL NOT NULL DEFAULT 0,
                        total_value REAL NOT NULL DEFAULT 0,
                        balance_after REAL NOT NULL DEFAULT 0,
                        transaction_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

                        FOREIGN KEY (items_id) REFERENCES items(items_id))
            `).run()

            const insertCategory = db.prepare(`
                INSERT OR IGNORE INTO categories (category_name)
                VALUES (?)
            `)
            for (const category of DEFAULT_CATEGORIES) {

                insertCategory.run(category)
            }
        })

    createTablesTransaction()
}

function createIndexes() {

    db.exec(`
        CREATE INDEX IF NOT EXISTS
            idx_items_category_id
        ON items(category_id);

        CREATE INDEX IF NOT EXISTS
            idx_stock_transactions_items_id
        ON stock_transactions(items_id);
    `)
}

function runMigrations() {

    const currentVersion = getSchemaVersion()

    if (currentVersion > CURRENT_SCHEMA_VERSION) {
        throw new Error(`Database schema version ${currentVersion} ` +
                        `is newer than the application supports ` +
                        `(${CURRENT_SCHEMA_VERSION}).`)
    }

    if (currentVersion < 2) {

        const migrateToVersion2 =
            db.transaction(() => {
                createIndexes()
                setSchemaVersion(2)
            })

        migrateToVersion2()
    }

    const finalVersion =getSchemaVersion()

    if (finalVersion !== CURRENT_SCHEMA_VERSION) {

        throw new Error(`Database migration incomplete. ` +
                        `Expected version ` +
                        `${CURRENT_SCHEMA_VERSION}, ` +
                        `got ${finalVersion}.`)
    }
}

function configureDatabase() {

    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    db.pragma('busy_timeout = 5000')
}

export function openDatabase() {

    if (db) {
        if (db.open) {
            return db
        }
        db = null
    }

    try {

        db = new Sqlite(dbPath)
        configureDatabase()

        if (!hasInitialSchema()) {

            console.log('INITIALIZING HOSPITRAX DATABASE SCHEMA')
            createTables()
            setSchemaVersion(1)
        }

        runMigrations()
        return db
    }
    catch (error) {

        console.error('DATABASE OPEN ERROR:', error)
        if (db) {

            try {
                if (db.open) {
                    db.close()
                }
            }
            catch (closeError) {
                console.error('FAILED TO CLOSE DATABASE AFTER OPEN ERROR:', closeError)
            }
        }

        db = null
        throw error
    }
}

export function getDatabase() {

    if (!db || !db.open) {
        return openDatabase()
    }
    return db
}

export function closeDatabase() {

    if (!db) {
        return
    }
    try {
        if (db.open) {
            db.close()
        }
    }
    catch (error) {
        console.error('DATABASE CLOSE ERROR:', error)
    }
    finally {
        db = null
    }
}

export function reopenDatabase() {
    closeDatabase()
    return openDatabase()
}

export { dbPath }