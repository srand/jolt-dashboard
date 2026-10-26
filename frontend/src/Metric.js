import React from 'react';

class Metric extends React.Component {
    render() {
        return (
            <div className="w3-container w3-cell w3-margin w3-padding w3-center jolt-box">
                <div className="jolt-box">
                    <p>{this.props.name}</p>
                    <h2>{this.props.value}</h2>
                </div>
            </div>
        )
    }
}

export default Metric;
