import React from 'react';

class Metric extends React.Component {
    constructor(props) {
        super(props);
        this.state = { count: props.value };
    }

    componentWillReceiveProps(newProps) {
        this.setState({ count: newProps.value });
    }

    render() {
        return (
            <div className="w3-container w3-cell w3-margin w3-padding w3-center jolt-box">
                <div className="jolt-box">
                    <p>{this.props.name}</p>
                    <h2>{this.state.count}</h2>
                </div>
            </div>
        )
    }
}

export default Metric;
