package model

import (
	"encoding/json"
	"strconv"
	"time"

	"github.com/montanaflynn/stats"
)

type BaseMetrics struct {
	WaitTime *TaskWaitTime
	Running  int
	Failed   int
	Passed   int
}

func NewBaseMetrics() *BaseMetrics {
	return &BaseMetrics{WaitTime: &TaskWaitTime{}}
}

type Metrics struct {
	BaseMetrics
	Queued int
}

func NewMetrics() *Metrics {
	return &Metrics{BaseMetrics: BaseMetrics{WaitTime: &TaskWaitTime{}}}
}

type DataSet struct {
	dataset stats.Float64Data `json:"-"`
	Min     json.Number
	Max     json.Number
	Mean    json.Number
	Median  json.Number
}

func (d *DataSet) Update() {
	min, _ := d.dataset.Min()
	max, _ := d.dataset.Max()
	mean, _ := d.dataset.Mean()
	median, _ := d.dataset.Median()
	d.Min = json.Number(strconv.FormatFloat(min, 'f', 3, 64))
	d.Max = json.Number(strconv.FormatFloat(max, 'f', 3, 64))
	d.Mean = json.Number(strconv.FormatFloat(mean, 'f', 3, 64))
	d.Median = json.Number(strconv.FormatFloat(median, 'f', 3, 64))
}

func (d *DataSet) Add(data float64) {
	d.dataset = append(d.dataset, data)
}

type TaskWaitTime struct {
	DataSet
}

func (d *TaskWaitTime) AddTask(task *Task) error {
	if task.Queued != "" {
		queued, err := time.Parse("2006-01-02 15:04:05", task.Queued)
		if err != nil {
			return err
		}

		var started time.Time
		if task.Started != "" {
			started, err = time.Parse("2006-01-02 15:04:05", task.Started)
			if err != nil {
				return err
			}
		} else {
			started = time.Now()
		}

		duration := started.Sub(queued).Seconds()
		if duration < 0 {
			duration = 0
		}
		d.Add(duration)
	}
	return nil
}

type Statistics struct {
	Tasks       *Metrics
	RoutingKeys map[string]*Metrics
	Workers     map[string]*BaseMetrics
}
