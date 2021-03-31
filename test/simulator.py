import requests
import random
import time
import uuid
import json
import hashlib

def sha1(data):
    sha = hashlib.sha1()
    sha.update(data.encode())
    return sha.hexdigest()

def randitem(lst):
    return lst[random.randint(0, len(lst)-1)]

workers = ["worker-" + str(i) for i in range(5)]
taskname = ["onion", "cucumber", "orange", "banana", "apple", "squash", "gridlock", "majo"]


class Task:
    def __init__(self):
        self.name = randitem(taskname)
        self.identity = sha1(str(uuid.uuid4()))
        self.uuid = str(uuid.uuid4())
        self.worker = randitem(workers)
        self.started = False

    def post(self, endpoint):
        try:
            r = requests.post("http://localhost:5000/api/v1/"+endpoint, json={
                "name": self.name,
                "identity": self.identity,
                "uuid": self.uuid,
                "worker": self.worker,
            })
            r.raise_for_status()
        except Exception as e:
            print(e)
            print(endpoint, "failed")

    def post_queued(self):
        self.post("task/queued")

    def post_started(self):
        self.post("task/started")
        self.started = True

    def post_finished(self):
        self.post("task/finished")

    def post_failed(self):
        self.post("task/failed")




tasks = [None for _ in range(10)]

while True:
    i = random.randint(0, 9)

    task = tasks[i]
    if task:
        if not task.started:
            task.post_started()
        else:
            [task.post_finished, task.post_failed][random.randint(0,1)]()
            tasks[i] = None
    else:
        tasks[i] = task = Task()
        task.post_queued()

    time.sleep(0.2)
