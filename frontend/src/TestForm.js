import React from 'react';
import { useState } from 'react';

class TestForm extends React.Component {
    constructor(props) {
        super(props);
        this.state = {
            posts: [],
        }
    }
    
    componentDidMount() {
        this.fetchUsers();
    }

    fetchUsers() {
        fetch('https://reqres.in/api/posts')
        .then(response => response.json())
        .then(data => this.setState({ posts: data.data }));
    }

    render() {
        return (
            <div>
                {this.state.posts.map((book) => (
                   <h1>{book.name}</h1>
                ))}
            </div>
        )
    }
}

export default TestForm;
