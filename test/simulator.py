#!/usr/bin/python

import requests
import random
import time
import uuid
import json
import hashlib
import sys

def sha1(data):
    sha = hashlib.sha1()
    sha.update(data.encode())
    return sha.hexdigest()

def randitem(lst):
    return lst[random.randint(0, len(lst)-1)]

routing_keys = ["default", "test"]
workers = ["worker-" + str(i) for i in range(10)]
taskname = ["onion", "cucumber", "orange", "banana", "apple", "squash", "gridlock", "majo"]

try:
    url = sys.argv[1]
except:
    url = "localhost"

class Task:
    def __init__(self):
        self.identity = sha1(str(uuid.uuid4()))
        self.instance = str(uuid.uuid4())
        self.name = randitem(taskname)
        self.routing_key = randitem(routing_keys)
        self.started = False
        self.worker = randitem(workers)

    def post(self, event):
        try:
            r = requests.post("http://" + url + "/api/v1/tasks", json={
                "event": event,
                "hostname": self.worker,
                "identity": self.identity,
                "instance": self.instance,
                "name": self.name,
                "role": "client" if event == "queued" else "worker",
                "routing_key": self.routing_key,
                "log": "https://ftp.sunet.se/mirror/archive/ftp.sunet.se/pub/simtelnet/CDROMS.TXT",
            })
            r.raise_for_status()
        except Exception as e:
            print(e)

    def post_queued(self):
        self.post("queued")

    def post_started(self):
        self.post("started")
        self.started = True

    def post_finished(self):
        self.post("finished")

    def post_failed(self):
        self.post("failed")

    def post_cancelled(self):
        self.post("cancelled")




tasks = [None for _ in range(10)]

while True:
    i = random.randint(0, len(tasks)-1)

    task = tasks[i]
    if task:
        if not task.started:
            if random.randint(0,2) > 0:
                task.post_started()
            else:
                task.post_cancelled()
                tasks[i] = None
        else:
            [task.post_finished, task.post_failed][random.randint(0,1)]()
            tasks[i] = None
    else:
        tasks[i] = task = Task()
        task.post_queued()

    time.sleep(.1)
