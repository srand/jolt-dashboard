package model

import (
	"log"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

type Database struct {
	db *gorm.DB
}

func NewDatabase() *Database {
	db, err := gorm.Open(sqlite.Open("gorm.db"), &gorm.Config{})
	if err != nil {
		log.Fatal(err)
	}

	return &Database{db: db}
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
