const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
app.use(express.json());
app.use(cors());

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Create tables
const setupDatabase = async () => {
  try {
    // Users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'student',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Books table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS books (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        author VARCHAR(255) NOT NULL,
        isbn VARCHAR(50) UNIQUE NOT NULL,
        category VARCHAR(100),
        available BOOLEAN DEFAULT TRUE,
        added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Borrow records table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS borrow_records (
        id SERIAL PRIMARY KEY,
        book_id INTEGER REFERENCES books(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        borrowed_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        due_date TIMESTAMP,
        returned_date TIMESTAMP,
        status VARCHAR(50) DEFAULT 'borrowed'
      )
    `);

    console.log("✅ Database tables created successfully");
  } catch (error) {
    console.error("❌ Database setup error:", error);
  }
};

// Initialize database
setupDatabase();

// ========== AUTH ROUTES ==========
// Register user
app.post("/api/auth/register", async (req, res) => {
  try {
    const { email, password, name, role } = req.body;
    
    const result = await pool.query(
      "INSERT INTO users (email, password, name, role) VALUES ($1, $2, $3, $4) RETURNING id, email, name, role",
      [email, password, name, role || "student"]
    );
    
    res.status(201).json({
      message: "User registered successfully",
      user: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({ message: "Registration failed" });
  }
});

// Login user
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    
    const result = await pool.query(
      "SELECT * FROM users WHERE email = $1 AND password = $2",
      [email, password]
    );
    
    if (result.rows.length === 0) {
      return res.status(401).json({ message: "Invalid credentials" });
    }
    
    const user = result.rows[0];
    delete user.password;
    
    res.json({
      message: "Login successful",
      user: user
    });
  } catch (error) {
    res.status(500).json({ message: "Login failed" });
  }
});

// ========== BOOK ROUTES ==========
// Get all books
app.get("/api/books", async (req, res) => {
  try {
    const { search } = req.query;
    let query = "SELECT * FROM books";
    let params = [];
    
    if (search) {
      query += " WHERE LOWER(title) LIKE LOWER($1) OR LOWER(author) LIKE LOWER($1)";
      params.push(`%${search}%`);
    }
    
    query += " ORDER BY title";
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch books" });
  }
});

// Add new book (admin)
app.post("/api/books", async (req, res) => {
  try {
    const { title, author, isbn, category } = req.body;
    
    const result = await pool.query(
      "INSERT INTO books (title, author, isbn, category) VALUES ($1, $2, $3, $4) RETURNING *",
      [title, author, isbn, category]
    );
    
    res.status(201).json({
      message: "Book added successfully",
      book: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to add book" });
  }
});

// Update book
app.put("/api/books/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { title, author, isbn, category, available } = req.body;
    
    const result = await pool.query(
      "UPDATE books SET title = $1, author = $2, isbn = $3, category = $4, available = $5 WHERE id = $6 RETURNING *",
      [title, author, isbn, category, available, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Book not found" });
    }
    
    res.json({
      message: "Book updated successfully",
      book: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to update book" });
  }
});

// Delete book
app.delete("/api/books/:id", async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query("DELETE FROM books WHERE id = $1 RETURNING id", [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Book not found" });
    }
    
    res.json({ message: "Book deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Failed to delete book" });
  }
});

// ========== BORROW ROUTES ==========
// Borrow a book
app.post("/api/borrow/borrow", async (req, res) => {
  try {
    const { book_id, user_id } = req.body;
    
    // Check if book is available
    const bookCheck = await pool.query(
      "SELECT * FROM books WHERE id = $1 AND available = true",
      [book_id]
    );
    
    if (bookCheck.rows.length === 0) {
      return res.status(400).json({ message: "Book not available" });
    }
    
    // Calculate due date (14 days from now)
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 14);
    
    // Create borrow record
    const borrowResult = await pool.query(
      "INSERT INTO borrow_records (book_id, user_id, due_date) VALUES ($1, $2, $3) RETURNING *",
      [book_id, user_id, dueDate]
    );
    
    // Update book availability
    await pool.query(
      "UPDATE books SET available = false WHERE id = $1",
      [book_id]
    );
    
    res.status(201).json({
      message: "Book borrowed successfully",
      record: borrowResult.rows[0]
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to borrow book" });
  }
});

// Return a book
app.post("/api/borrow/return", async (req, res) => {
  try {
    const { record_id } = req.body;
    
    // Get borrow record
    const record = await pool.query(
      "SELECT * FROM borrow_records WHERE id = $1",
      [record_id]
    );
    
    if (record.rows.length === 0) {
      return res.status(404).json({ message: "Borrow record not found" });
    }
    
    const bookId = record.rows[0].book_id;
    
    // Update borrow record
    await pool.query(
      "UPDATE borrow_records SET returned_date = CURRENT_TIMESTAMP, status = 'returned' WHERE id = $1",
      [record_id]
    );
    
    // Update book availability
    await pool.query(
      "UPDATE books SET available = true WHERE id = $1",
      [bookId]
    );
    
    res.json({ message: "Book returned successfully" });
  } catch (error) {
    res.status(500).json({ message: "Failed to return book" });
  }
});

// Get user's borrowed books
app.get("/api/borrow/user/:user_id", async (req, res) => {
  try {
    const { user_id } = req.params;
    
    const result = await pool.query(`
      SELECT b.*, br.borrowed_date, br.due_date, br.status, br.id as record_id
      FROM borrow_records br
      JOIN books b ON br.book_id = b.id
      WHERE br.user_id = $1 AND br.status = 'borrowed'
      ORDER BY br.due_date
    `, [user_id]);
    
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch borrowed books" });
  }
});

// ========== TEST ROUTES ==========
app.get("/", (req, res) => {
  res.send("✅ ScholarSync Library Backend is running");
});

app.get("/test-db", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({ 
      message: "✅ Database connected successfully",
      time: result.rows[0].now 
    });
  } catch (error) {
    res.status(500).json({ error: "❌ Database connection failed" });
  }
});

// ========== START SERVER ==========
const PORT = process.env.PORT || 3004;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📚 Endpoints:`);
  console.log(`   GET  /test-db`);
  console.log(`   POST /api/auth/register`);
  console.log(`   POST /api/auth/login`);
  console.log(`   GET  /api/books`);
  console.log(`   POST /api/books`);
  console.log(`   PUT  /api/books/:id`);
  console.log(`   DELETE /api/books/:id`);
});

