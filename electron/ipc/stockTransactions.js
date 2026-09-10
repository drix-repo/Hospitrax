import { ipcMain } from 'electron';
import { getDatabase} from '../database.js'

export function stockTransactionsHandlers(){
   
    ipcMain.handle('stockTransactions:getAll', ()=>{

         const db = getDatabase()
         const transactions = db.prepare(`
            SELECT  st.transaction_id, st.items_id, i.items_name,
                    i.category_id, c.category_name, st.transaction_type,
                    st.quantity, st.unit,
                    st.unit_cost AS item_cost,
                    st.total_value,
                    st.balance_after,
                    st.transaction_date
            FROM stock_transactions st
            LEFT JOIN items i
            ON st.items_id = i.items_id
            LEFT JOIN categories c
            ON i.category_id = c.category_id
            ORDER BY st.transaction_id ASC`)
            .all();
        return transactions
    })
    ipcMain.handle('stockTransactions:get', (_, id) => {

        const db = getDatabase()
        const transaction = db.prepare(`
            SELECT  st.transaction_id,
                    st.items_id,
                    i.items_name,
                    i.category_id,
                    c.category_name,
                    st.transaction_type,
                    st.quantity,
                    st.unit,
                    st.unit_cost AS item_cost,
                    st.total_value,
                    st.balance_after,
                    st.transaction_date
            FROM stock_transactions st
            LEFT JOIN items i
            ON st.items_id = i.items_id
            LEFT JOIN categories c
            ON i.category_id = c.category_id
            WHERE st.transaction_id = ?`)
            .get(Number(id));


        if (!transaction) {
            throw new Error(`Transaction id ${id} not found`);
        }
        return transaction


    })
}