package model

import (
	"fmt"
	"log"
	"sync"
	"time"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

const sqliteBusyTimeout = 5 * time.Second

type Database struct {
	db *gorm.DB
	// Task/build mutations and publication share a boundary, including snapshots.
	taskCoordinator sync.Mutex
	// Worker mutation, snapshot reads, and publication use the same boundary.
	workerCoordinator sync.Mutex
}

func NewDatabase() *Database {
	return NewDatabaseFromDsn("gorm.db")
}

func NewDatabaseFromDsn(dsn string) *Database {
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatal(err)
	}

	sqlDB, err := db.DB()
	if err != nil {
		log.Fatal(err)
	}
	// SQLite only supports one writer. Configure the pool first so the pragmas
	// and all later operations use the same connection.
	sqlDB.SetMaxOpenConns(1)
	sqlDB.SetMaxIdleConns(1)

	// WAL allows readers and the single writer to make progress concurrently.
	// busy_timeout makes SQLite wait for short-lived locks instead of dropping
	// scheduler events immediately.
	if err := db.Exec("PRAGMA journal_mode = WAL").Error; err != nil {
		log.Fatal(err)
	}
	if err := db.Exec(fmt.Sprintf("PRAGMA busy_timeout = %d", sqliteBusyTimeout.Milliseconds())).Error; err != nil {
		log.Fatal(err)
	}

	return &Database{db: db}
}

func (db *Database) Close() error {
	sqlDB, err := db.db.DB()
	if err != nil {
		return err
	}
	return sqlDB.Close()
}

func (db *Database) Create(obj interface{}) error {
	db.db.Create(obj)
	return db.db.Error
}

func (db *Database) Delete(obj interface{}, conds ...interface{}) error {
	db.db.Delete(obj)
	return db.db.Error
}

func (db *Database) AutoMigrate(obj interface{}) error {
	db.db.AutoMigrate(obj)
	return db.db.Error
}
